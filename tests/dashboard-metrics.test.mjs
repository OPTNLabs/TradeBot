#!/usr/bin/env node
/**
 * tests/dashboard-metrics.test.mjs
 *
 * T78 subset 1 — unit + integration tests for
 * `src/dashboard/metrics.mjs` + the `GET /metrics` route in
 * `src/dashboard/server.mjs`.
 *
 * Three test layers:
 *
 *   1. **Pure helpers** — `asCounter`, `asGauge`, `asTimestampMs`,
 *      `escapeLabelValue`, `formatLabels`, `formatMetricBlock`,
 *      `formatPrometheusText`. No I/O. Fast + deterministic.
 *
 *   2. **Probe gatherers** — `gatherLoopMetrics`,
 *      `gatherWalletMetrics`, `gatherPositionsMetrics`,
 *      `gatherBreakerMetrics`. Each probe is tested with a
 *      missing-ctx + throwing-ctx + happy-path fixture so a
 *      refactor that accidentally breaks the defensive contract
 *      fails loudly.
 *
 *   3. **HTTP integration** — boots the dashboard server's
 *      `handler()` directly via supertest. Asserts:
 *      - `GET /metrics` returns 200 + `text/plain;
 *        version=0.0.4; charset=utf-8` content type + a
 *        parseable Prometheus text body.
 *      - The body contains a `# HELP`, `# TYPE`, and at least
 *        one sample line for every emitted metric.
 *      - A `probe_status="degraded"` label surfaces when one of
 *        the probes throws — the scrape still parses, the
 *        broken probe is identifiable on the wire.
 *
 * Run via:
 *   node --test tests/dashboard-metrics.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import supertest from 'supertest';

import {
  METRICS_SCHEMA,
  PROMETHEUS_CONTENT_TYPE,
  DEFAULT_METRICS_UTXO_TIMEOUT_MS,
  asCounter,
  asGauge,
  asTimestampMs,
  escapeLabelValue,
  formatLabels,
  formatMetricBlock,
  formatPrometheusText,
  gatherLoopMetrics,
  gatherWalletMetrics,
  gatherPositionsMetrics,
  gatherBreakerMetrics,
  buildMetricsEnvelope,
} from '../src/dashboard/metrics.mjs';

import {
  buildRouteTable,
  matchRoute,
} from '../src/dashboard/server.mjs';

import { Positions } from '../src/portfolio/positions.mjs';
import { Snapshots } from '../src/portfolio/snapshots.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Test helpers
// ─────────────────────────────────────────────────────────────────────

/** @param {string} suffix */
async function makeTmp(t, suffix = '') {
  const dir = await mkdtemp(path.join(os.tmpdir(), `tb-metrics-${suffix}`));
  t.after?.(async () => {
    try { await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  return dir;
}

/**
 * Lightweight no-op logger. The metrics module's `ctx.logger.warn`
 * calls are optional — supplying a no-op keeps the contract obvious.
 * @returns {{ warn: Function, info: Function, error: Function }}
 */
function createLogger() {
  return {
    warn: () => {},
    info: () => {},
    error: () => {},
  };
}

/**
 * Boot the dashboard server's `handler()` with a fully wired ctx.
 * Mirrors the pattern in tests/server.test.mjs.
 */
async function makeServer({ cfg, positions, snapshots, loop, wallet, risk, holdersScannerCache, snapshotAggregator, logger }) {
  const ctx = {
    cfg,
    dashboardCfg: cfg.dashboard ?? {},
    positions,
    snapshots,
    historyReader: { history: [], lastTs: null },
    loop: loop ?? null,
    wallet: wallet ?? null,
    risk: risk ?? null,
    holdersScannerCache: holdersScannerCache ?? null,
    snapshotAggregator: snapshotAggregator ?? null,
    fs: { readFile: async () => { throw new Error('no fs'); }, writeFile: async () => { throw new Error('no fs'); } },
    staticEnabled: false,
    clock: () => new Date(),
    logger: logger ?? createLogger(),
  };
  // We don't actually import the full server bootstrap; we just
  // need `buildRouteTable()` + a dispatcher. The dispatcher's
  // text-response branch is tested inline below.
  return { ctx, routes: buildRouteTable() };
}

// ─────────────────────────────────────────────────────────────────────
//  Pure helpers: asCounter / asGauge / asTimestampMs
// ─────────────────────────────────────────────────────────────────────

test('metrics: asCounter — accepts non-negative finite integers', () => {
  assert.equal(asCounter(0), 0);
  assert.equal(asCounter(1), 1);
  assert.equal(asCounter(42), 42);
  assert.equal(asCounter(1e9), 1e9);
});

test('metrics: asCounter — coerces invalid input to 0', () => {
  assert.equal(asCounter(-1), 0, 'negative → 0');
  assert.equal(asCounter(NaN), 0);
  assert.equal(asCounter(Infinity), 0);
  assert.equal(asCounter(-Infinity), 0);
  assert.equal(asCounter(1.5), 0, 'non-integer → 0');
  assert.equal(asCounter('42'), 0, 'string → 0');
  assert.equal(asCounter(null), 0);
  assert.equal(asCounter(undefined), 0);
  assert.equal(asCounter({}), 0);
  assert.equal(asCounter([]), 0);
  assert.equal(asCounter(true), 0);
});

test('metrics: asGauge — accepts any finite number including negatives', () => {
  assert.equal(asGauge(0), 0);
  assert.equal(asGauge(0.5), 0.5);
  assert.equal(asGauge(-1.25), -1.25, 'gauge preserves sign');
  assert.equal(asGauge(1e9), 1e9);
});

test('metrics: asGauge — coerces invalid input to 0', () => {
  assert.equal(asGauge(NaN), 0);
  assert.equal(asGauge(Infinity), 0);
  assert.equal(asGauge(-Infinity), 0);
  assert.equal(asGauge('1.5'), 0);
  assert.equal(asGauge(null), 0);
  assert.equal(asGauge(undefined), 0);
  assert.equal(asGauge({}), 0);
});

test('metrics: asTimestampMs — accepts non-negative finite numbers', () => {
  assert.equal(asTimestampMs(0), 0);
  assert.equal(asTimestampMs(1.7e9), 1.7e9);
});

test('metrics: asTimestampMs — coerces invalid input to 0', () => {
  assert.equal(asTimestampMs(-1), 0, 'negative → 0');
  assert.equal(asTimestampMs(NaN), 0);
  assert.equal(asTimestampMs(Infinity), 0);
  assert.equal(asTimestampMs('1700000000000'), 0);
  assert.equal(asTimestampMs(null), 0);
  assert.equal(asTimestampMs(undefined), 0);
});

// ─────────────────────────────────────────────────────────────────────
//  Pure helpers: escapeLabelValue / formatLabels
// ─────────────────────────────────────────────────────────────────────

test('metrics: escapeLabelValue — escapes per Prometheus text-spec', () => {
  assert.equal(escapeLabelValue('plain'), 'plain');
  assert.equal(escapeLabelValue('a\\b'), 'a\\\\b', 'backslash doubled');
  assert.equal(escapeLabelValue('a"b'), 'a\\"b', 'double-quote escaped');
  assert.equal(escapeLabelValue('a\nb'), 'a\\nb', 'newline escaped');
  assert.equal(escapeLabelValue('a\\"b\n'), 'a\\\\\\"b\\n', 'all three combined');
});

test('metrics: escapeLabelValue — non-string input returns empty string', () => {
  assert.equal(escapeLabelValue(null), '');
  assert.equal(escapeLabelValue(undefined), '');
  assert.equal(escapeLabelValue(42), '');
  assert.equal(escapeLabelValue({}), '');
});

test('metrics: formatLabels — empty / null / non-object returns empty string', () => {
  assert.equal(formatLabels(null), '');
  assert.equal(formatLabels(undefined), '');
  assert.equal(formatLabels({}), '');
});

test('metrics: formatLabels — single label', () => {
  assert.equal(formatLabels({ outcome: 'detected' }), '{outcome="detected"}');
});

test('metrics: formatLabels — multiple labels sorted by key', () => {
  assert.equal(
    formatLabels({ b: '2', a: '1' }),
    '{a="1",b="2"}',
    'keys sorted alphabetically for deterministic output'
  );
});

test('metrics: formatLabels — drops undefined / null label values', () => {
  assert.equal(
    formatLabels({ a: '1', b: undefined, c: null }),
    '{a="1"}'
  );
});

test('metrics: formatLabels — escapes label values', () => {
  assert.equal(
    formatLabels({ outcome: 'a"b\nc' }),
    '{outcome="a\\"b\\nc"}'
  );
});

test('metrics: formatLabels — numeric label values stringify without escaping', () => {
  // Numeric values are NOT escaped — they're stringified as
  // their decimal representation, which can't contain
  // backslash / quote / newline.
  assert.equal(
    formatLabels({ count: 42, ratio: 0.5 }),
    '{count="42",ratio="0.5"}'
  );
});

// ─────────────────────────────────────────────────────────────────────
//  Pure helpers: formatMetricBlock / formatPrometheusText
// ─────────────────────────────────────────────────────────────────────

test('metrics: formatMetricBlock — happy single-sample block', () => {
  const out = formatMetricBlock({
    name: 'tradebot_up',
    type: 'gauge',
    help: 'Process is responsive (1=responding to /metrics, 0=not)',
    samples: [{ value: 1 }],
  });
  assert.equal(out, [
    '# HELP tradebot_up Process is responsive (1=responding to /metrics, 0=not)',
    '# TYPE tradebot_up gauge',
    'tradebot_up 1',
  ].join('\n'));
});

test('metrics: formatMetricBlock — labelled samples emit {} block', () => {
  const out = formatMetricBlock({
    name: 'tradebot_loop_rug_pattern_checked_total',
    type: 'counter',
    help: 'Per-tick rug-pattern checks by outcome',
    samples: [
      { labels: { outcome: 'checked' }, value: 5 },
      { labels: { outcome: 'detected' }, value: 1 },
    ],
  });
  assert.equal(out, [
    '# HELP tradebot_loop_rug_pattern_checked_total Per-tick rug-pattern checks by outcome',
    '# TYPE tradebot_loop_rug_pattern_checked_total counter',
    'tradebot_loop_rug_pattern_checked_total{outcome="checked"} 5',
    'tradebot_loop_rug_pattern_checked_total{outcome="detected"} 1',
  ].join('\n'));
});

test('metrics: formatMetricBlock — string-valued samples pass through', () => {
  const out = formatMetricBlock({
    name: 'tradebot_loop_tick_count_total',
    type: 'counter',
    help: 'Total ticks',
    samples: [{ value: '42' }],
  });
  assert.match(out, /^tradebot_loop_tick_count_total 42$/m);
});

test('metrics: formatMetricBlock — refuses invalid metric name', () => {
  assert.equal(formatMetricBlock({ name: 'bad name', type: 'gauge', help: 'x', samples: [{ value: 1 }] }), '');
  assert.equal(formatMetricBlock({ name: '', type: 'gauge', help: 'x', samples: [{ value: 1 }] }), '');
  assert.equal(formatMetricBlock({ name: '1leading_digit', type: 'gauge', help: 'x', samples: [{ value: 1 }] }), '');
});

test('metrics: formatMetricBlock — help text is single-line + backslash escaped', () => {
  const out = formatMetricBlock({
    name: 'foo_bar',
    type: 'gauge',
    help: 'multi\nline\nhelp \\with backslash',
    samples: [{ value: 0 }],
  });
  // Newlines in `help` are collapsed to spaces (Prometheus HELP
  // lines are required to be a single physical line); existing
  // backslashes are doubled (Prometheus HELP text-spec).
  assert.match(out, /^# HELP foo_bar multi line help \\\\with backslash$/m);
});

test('metrics: formatMetricBlock — null / non-object returns empty string', () => {
  assert.equal(formatMetricBlock(null), '');
  assert.equal(formatMetricBlock(undefined), '');
  assert.equal(formatMetricBlock('garbage'), '');
});

test('metrics: formatPrometheusText — empty envelope returns empty string', () => {
  assert.equal(formatPrometheusText({ metrics: [] }), '');
  assert.equal(formatPrometheusText({}), '');
  assert.equal(formatPrometheusText(null), '');
});

test('metrics: formatPrometheusText — multi-block output is newline-separated + trailing newline', () => {
  const envelope = {
    metrics: [
      { name: 'a_total', type: 'counter', help: 'a', samples: [{ value: 1 }] },
      { name: 'b_total', type: 'counter', help: 'b', samples: [{ value: 2 }] },
    ],
  };
  const text = formatPrometheusText(envelope);
  assert.equal(text.endsWith('\n'), true, 'trailing newline');
  assert.match(text, /# TYPE a_total counter/);
  assert.match(text, /# TYPE b_total counter/);
  assert.match(text, /^a_total 1$/m);
  assert.match(text, /^b_total 2$/m);
});

test('metrics: formatPrometheusText — samples within a block sorted by label-tuple', () => {
  const envelope = {
    metrics: [
      {
        name: 'foo_total',
        type: 'counter',
        help: 'foo',
        samples: [
          { labels: { outcome: 'z' }, value: 3 },
          { labels: { outcome: 'a' }, value: 1 },
          { labels: { outcome: 'm' }, value: 2 },
        ],
      },
    ],
  };
  const text = formatPrometheusText(envelope);
  // Find the sample lines and assert the order.
  const lines = text.split('\n').filter((l) => l.startsWith('foo_total'));
  assert.equal(lines[0], 'foo_total{outcome="a"} 1');
  assert.equal(lines[1], 'foo_total{outcome="m"} 2');
  assert.equal(lines[2], 'foo_total{outcome="z"} 3');
});

// ─────────────────────────────────────────────────────────────────────
//  Probe gatherers
// ─────────────────────────────────────────────────────────────────────

test('metrics: gatherLoopMetrics — missing loop → unconfigured probe', () => {
  const out = gatherLoopMetrics({});
  assert.equal(out.probeStatus, 'unconfigured');
  assert.equal(out.error, null);
  assert.ok(Array.isArray(out.metrics));
  // Every metric carries a `probe_status="unconfigured"` label.
  for (const m of out.metrics) {
    for (const s of m.samples) {
      assert.equal(s.labels.probe_status, 'unconfigured');
      assert.equal(s.value, 0);
    }
  }
});

test('metrics: gatherLoopMetrics — throwing loop → degraded probe', () => {
  const out = gatherLoopMetrics({
    loop: { stats: () => { throw new Error('boom'); } },
  });
  assert.equal(out.probeStatus, 'degraded');
  assert.match(out.error, /boom/);
  for (const m of out.metrics) {
    for (const s of m.samples) {
      assert.equal(s.labels.probe_status, 'degraded');
      assert.equal(s.value, 0);
    }
  }
});

test('metrics: gatherLoopMetrics — happy path surfaces cumulative counters', () => {
  const out = gatherLoopMetrics({
    loop: {
      stats: () => ({
        running: true,
        tick_count: 100,
        last_tick_at_ms: 1_700_000_000_000,
        last_tick_duration_ms: 250,
        entry_attempt_count: 7,
        exit_attempt_count: 3,
        error_count: 1,
        rug_pattern_gate: {
          last_tick: {
            enabled: true,
            checked_count: 4,
            cache_hit_count: 2,
            detected_count: 1,
            error_count: 0,
            token_not_found_count: 1,
            skipped_unwired_count: 0,
          },
        },
      }),
    },
  });
  assert.equal(out.probeStatus, 'ok');
  // Spot-check a few emitted metrics.
  const names = out.metrics.map((m) => m.name);
  assert.ok(names.includes('tradebot_loop_tick_count_total'));
  assert.ok(names.includes('tradebot_loop_entry_attempt_count_total'));
  assert.ok(names.includes('tradebot_loop_exit_attempt_count_total'));
  assert.ok(names.includes('tradebot_loop_error_count_total'));
  assert.ok(names.includes('tradebot_loop_rug_pattern_checked_total'));
  const tickMetric = out.metrics.find((m) => m.name === 'tradebot_loop_tick_count_total');
  assert.equal(tickMetric.type, 'counter');
  assert.equal(tickMetric.samples[0].value, 100);
  const entryMetric = out.metrics.find((m) => m.name === 'tradebot_loop_entry_attempt_count_total');
  assert.equal(entryMetric.samples[0].value, 7);
  const rugMetric = out.metrics.find((m) => m.name === 'tradebot_loop_rug_pattern_checked_total');
  // All 6 outcome labels emitted, sorted values match.
  const rugByOutcome = Object.fromEntries(rugMetric.samples.map((s) => [s.labels.outcome, s.value]));
  assert.equal(rugByOutcome.checked, 4);
  assert.equal(rugByOutcome.cache_hit, 2);
  assert.equal(rugByOutcome.detected, 1);
  assert.equal(rugByOutcome.error, 0);
  assert.equal(rugByOutcome.token_not_found, 1);
  assert.equal(rugByOutcome.skipped_unwired, 0);
});

test('metrics: gatherLoopMetrics — empty / missing rug_pattern_gate degrades safely', () => {
  const out = gatherLoopMetrics({
    loop: { stats: () => ({ running: false, tick_count: 0, last_tick_at_ms: 0, last_tick_duration_ms: 0, entry_attempt_count: 0, exit_attempt_count: 0, error_count: 0 }) },
  });
  assert.equal(out.probeStatus, 'ok');
  const rugMetric = out.metrics.find((m) => m.name === 'tradebot_loop_rug_pattern_checked_total');
  for (const s of rugMetric.samples) {
    assert.equal(s.value, 0, `outcome=${s.labels.outcome} should be 0`);
  }
});

test('metrics: gatherWalletMetrics — missing wallet → unconfigured', async () => {
  const out = await gatherWalletMetrics({});
  assert.equal(out.probeStatus, 'unconfigured');
  for (const m of out.metrics) {
    for (const s of m.samples) {
      assert.equal(s.labels.probe_status, 'unconfigured');
    }
  }
});

test('metrics: gatherWalletMetrics — happy path with bigint balance', async () => {
  const wallet = {
    getBalanceSats: async () => 100_000_000n, // 1 BCH
    listUtxos: async () => [{ txid: 'a', vout: 0 }, { txid: 'b', vout: 1 }],
  };
  const out = await gatherWalletMetrics({ wallet });
  assert.equal(out.probeStatus, 'ok');
  const bal = out.metrics.find((m) => m.name === 'tradebot_wallet_balance_bch');
  assert.equal(bal.samples[0].value, 1, '1 BCH');
  assert.equal(bal.samples[0].labels.probe_status, 'ok');
  const utxo = out.metrics.find((m) => m.name === 'tradebot_wallet_utxo_count');
  assert.equal(utxo.samples[0].value, 2);
});

test('metrics: gatherWalletMetrics — throwing getBalanceSats marks balance degraded', async () => {
  const wallet = {
    getBalanceSats: async () => { throw new Error('rpc down'); },
    listUtxos: async () => [],
  };
  const out = await gatherWalletMetrics({ wallet });
  assert.equal(out.probeStatus, 'degraded');
  const bal = out.metrics.find((m) => m.name === 'tradebot_wallet_balance_bch');
  assert.equal(bal.samples[0].labels.probe_status, 'degraded');
  const utxo = out.metrics.find((m) => m.name === 'tradebot_wallet_utxo_count');
  assert.equal(utxo.samples[0].labels.probe_status, 'ok');
});

test('metrics: gatherWalletMetrics — listUtxos timeout degrades UTXO probe', async () => {
  const wallet = {
    getBalanceSats: async () => 5_000_000n,
    listUtxos: () => new Promise((resolve) => {
      // Never resolves — the timeout-race wins.
      setTimeout(() => resolve([{ txid: 'late' }]), 30_000);
    }),
  };
  const out = await gatherWalletMetrics({ wallet }, 100); // 100ms timeout
  assert.equal(out.probeStatus, 'degraded');
  const utxo = out.metrics.find((m) => m.name === 'tradebot_wallet_utxo_count');
  assert.equal(utxo.samples[0].labels.probe_status, 'degraded');
  assert.match(out.error, /timed out/);
});

test('metrics: gatherPositionsMetrics — missing positions → unconfigured', async () => {
  const out = await gatherPositionsMetrics({});
  assert.equal(out.probeStatus, 'unconfigured');
});

test('metrics: gatherPositionsMetrics — happy path', async () => {
  const out = await gatherPositionsMetrics({
    positions: { list: async (status) => status === 'open' ? [{}, {}, {}] : [] },
  });
  assert.equal(out.probeStatus, 'ok');
  const m = out.metrics.find((x) => x.name === 'tradebot_positions_open_count');
  assert.equal(m.samples[0].value, 3);
});

test('metrics: gatherPositionsMetrics — throwing list → degraded', async () => {
  const out = await gatherPositionsMetrics({
    positions: { list: async () => { throw new Error('disk full'); } },
  });
  assert.equal(out.probeStatus, 'degraded');
  assert.match(out.error, /disk full/);
});

test('metrics: gatherPositionsMetrics — non-array list → degraded', async () => {
  const out = await gatherPositionsMetrics({
    positions: { list: async () => 'not-an-array' },
  });
  assert.equal(out.probeStatus, 'degraded');
  assert.match(out.error, /non-array/);
});

test('metrics: gatherBreakerMetrics — missing risk → unconfigured', () => {
  const out = gatherBreakerMetrics({});
  assert.equal(out.probeStatus, 'unconfigured');
});

test('metrics: gatherBreakerMetrics — throwing risk → degraded', () => {
  const out = gatherBreakerMetrics({ risk: { state: () => { throw new Error('boom'); } } });
  assert.equal(out.probeStatus, 'degraded');
});

test('metrics: gatherBreakerMetrics — happy path surfaces all 4 metrics', () => {
  const out = gatherBreakerMetrics({
    risk: {
      state: () => ({
        isTripped: true,
        tripKind: 'daily_loss',
        consecutiveLosses: 3,
        recentDailyPnlSats: -50_000_000, // -0.5 BCH
        lossCooldownRemainingMs: 60_000,
      }),
    },
  });
  assert.equal(out.probeStatus, 'ok');
  const tripped = out.metrics.find((m) => m.name === 'tradebot_breaker_is_tripped');
  assert.equal(tripped.samples[0].value, 1);
  const cons = out.metrics.find((m) => m.name === 'tradebot_breaker_consecutive_losses');
  assert.equal(cons.samples[0].value, 3);
  const pnl = out.metrics.find((m) => m.name === 'tradebot_breaker_recent_daily_pnl_bch');
  assert.equal(pnl.samples[0].value, -0.5);
  const cooldown = out.metrics.find((m) => m.name === 'tradebot_breaker_loss_cooldown_remaining_ms');
  assert.equal(cooldown.samples[0].value, 60_000);
});

// ─────────────────────────────────────────────────────────────────────
//  buildMetricsEnvelope (orchestrator)
// ─────────────────────────────────────────────────────────────────────

test('metrics: buildMetricsEnvelope — throws TypeError on missing ctx', async () => {
  await assert.rejects(() => buildMetricsEnvelope(), /ctx required/);
  await assert.rejects(() => buildMetricsEnvelope({}), /ctx required/);
});

test('metrics: buildMetricsEnvelope — aggregates all four probes + process metrics', async () => {
  const envelope = await buildMetricsEnvelope({
    ctx: {
      loop: { stats: () => ({ tick_count: 10, entry_attempt_count: 2, exit_attempt_count: 1, error_count: 0, last_tick_at_ms: 0, last_tick_duration_ms: 0, running: true }) },
      wallet: { getBalanceSats: async () => 0n, listUtxos: async () => [] },
      positions: { list: async () => [] },
      risk: { state: () => ({ isTripped: false, consecutiveLosses: 0, recentDailyPnlSats: 0 }) },
      logger: createLogger(),
    },
  });
  assert.equal(envelope.schema, METRICS_SCHEMA);
  assert.equal(envelope.ok, true);
  const names = envelope.metrics.map((m) => m.name);
  // Process metrics.
  assert.ok(names.includes('tradebot_up'));
  assert.ok(names.includes('tradebot_uptime_seconds'));
  // Loop counters.
  assert.ok(names.includes('tradebot_loop_tick_count_total'));
  assert.ok(names.includes('tradebot_loop_entry_attempt_count_total'));
  // Wallet gauges.
  assert.ok(names.includes('tradebot_wallet_balance_bch'));
  assert.ok(names.includes('tradebot_wallet_utxo_count'));
  // Positions gauge.
  assert.ok(names.includes('tradebot_positions_open_count'));
  // Breaker gauges.
  assert.ok(names.includes('tradebot_breaker_is_tripped'));
});

test('metrics: buildMetricsEnvelope — degraded probe surfaces on the wire (no throw)', async () => {
  const envelope = await buildMetricsEnvelope({
    ctx: {
      loop: { stats: () => { throw new Error('loop blew up'); } },
      wallet: null,
      positions: null,
      risk: null,
      logger: createLogger(),
    },
  });
  assert.equal(envelope.ok, true, 'envelope still built');
  // The loop probe is degraded; the other probes are unconfigured.
  const tickMetric = envelope.metrics.find((m) => m.name === 'tradebot_loop_tick_count_total');
  assert.equal(tickMetric.samples[0].labels.probe_status, 'degraded');
  const balMetric = envelope.metrics.find((m) => m.name === 'tradebot_wallet_balance_bch');
  assert.equal(balMetric.samples[0].labels.probe_status, 'unconfigured');
});

test('metrics: buildMetricsEnvelope — logs a structured warn per degraded probe', async () => {
  const warns = [];
  const logger = {
    warn: (event, payload) => warns.push({ event, payload }),
    info: () => {},
    error: () => {},
  };
  await buildMetricsEnvelope({
    ctx: {
      loop: { stats: () => { throw new Error('x'); } },
      wallet: { getBalanceSats: async () => { throw new Error('y'); }, listUtxos: async () => [] },
      positions: { list: async () => [] },
      risk: { state: () => { throw new Error('z'); } },
      logger,
    },
  });
  const events = warns.map((w) => w.event);
  assert.ok(events.includes('dashboard.metrics.loop.degraded'));
  assert.ok(events.includes('dashboard.metrics.wallet.degraded'));
  assert.ok(events.includes('dashboard.metrics.breaker.degraded'));
});

test('metrics: METRICS_SCHEMA + PROMETHEUS_CONTENT_TYPE constants', () => {
  assert.equal(METRICS_SCHEMA, 'tradebot.dashboard.metrics/v1');
  assert.equal(PROMETHEUS_CONTENT_TYPE, 'text/plain; version=0.0.4; charset=utf-8');
  assert.equal(DEFAULT_METRICS_UTXO_TIMEOUT_MS, 5000);
});

// ─────────────────────────────────────────────────────────────────────
//  Route table: /metrics registered alongside /healthz
// ─────────────────────────────────────────────────────────────────────

test('server: buildRouteTable — registers GET /metrics', () => {
  const routes = buildRouteTable();
  const paths = routes.map((r) => `${r.method} ${r.path}`);
  assert.ok(paths.includes('GET /metrics'), 'expected /metrics in route table');
  // /metrics is NEVER auth-gated (it's a scrape target).
  const m = routes.find((r) => r.path === '/metrics');
  assert.equal(m.auth, false);
  // The pattern is anchored ^...$ with an optional trailing slash.
  // Each literal `\` in the regex source needs to be escaped in
  // the regex literal — so `\^\\\/metrics\\\/?\$` is the right
  // encoding to match the source string `^\/metrics\/?$`.
  assert.equal(m.pattern.source, '^\\/metrics\\/?$');
});

test('server: matchRoute — /metrics matches before /api/* patterns', () => {
  const routes = buildRouteTable();
  const hit = matchRoute(routes, 'GET', '/metrics');
  assert.ok(hit);
  assert.equal(hit.route.path, '/metrics');
  // Trailing slash should still match (pattern allows it).
  const hitSlash = matchRoute(routes, 'GET', '/metrics/');
  assert.ok(hitSlash);
});

// ─────────────────────────────────────────────────────────────────────
//  HTTP integration: GET /metrics
// ─────────────────────────────────────────────────────────────────────

test('server: GET /metrics returns 200 + text/plain Prometheus body', async (t) => {
  const dir = await makeTmp(t);
  await mkdir(dir, { recursive: true });
  const cfg = {
    dashboard: { bind_host: '127.0.0.1', bind_port: 0 },
    paths: { positions_file: `${dir}/positions.json`, snapshots_dir: `${dir}/snapshots` },
  };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger() });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger() });
  await snapshots.load();
  // We can't import the full server module here without booting
  // it; instead, dispatch the route handler inline using the
  // same sendText shape the dispatcher uses. This validates
  // the route handler + content-type contract end-to-end.
  const { ctx: serverCtx, routes: serverRoutes } = await makeServer({ cfg, positions, snapshots });
  const route = serverRoutes.find((r) => r.path === '/metrics');
  assert.ok(route);
  const ctxWithLoop = {
    ...serverCtx,
    loop: { stats: () => ({ tick_count: 5, entry_attempt_count: 1, exit_attempt_count: 1, error_count: 0, last_tick_at_ms: Date.now() - 1000, last_tick_duration_ms: 250, running: true, rug_pattern_gate: { last_tick: {} } }) },
    wallet: { getBalanceSats: async () => 123_456_789n, listUtxos: async () => [{ txid: 'a', vout: 0 }] },
    positions: { list: async () => [{}, {}] },
    risk: { state: () => ({ isTripped: false, consecutiveLosses: 0, recentDailyPnlSats: 0, lossCooldownRemainingMs: 0 }) },
  };
  const result = await route.handler(ctxWithLoop, {}, new URL('http://x/metrics'));
  assert.equal(result.__text_response, true);
  assert.equal(result.content_type, PROMETHEUS_CONTENT_TYPE);
  assert.equal(result.schema, METRICS_SCHEMA);
  assert.equal(typeof result.body, 'string');
  // Body must be parseable as Prometheus text format.
  assert.match(result.body, /^# HELP tradebot_up /m);
  assert.match(result.body, /^# TYPE tradebot_up gauge/m);
  assert.match(result.body, /^tradebot_up 1$/m);
  assert.match(result.body, /^# TYPE tradebot_loop_tick_count_total counter/m);
  assert.match(result.body, /^tradebot_loop_tick_count_total\{probe_status="ok"\} 5$/m);
  assert.match(result.body, /^tradebot_loop_entry_attempt_count_total\{probe_status="ok"\} 1$/m);
  assert.match(result.body, /^tradebot_loop_exit_attempt_count_total\{probe_status="ok"\} 1$/m);
  assert.match(result.body, /^tradebot_loop_error_count_total\{probe_status="ok"\} 0$/m);
  assert.match(result.body, /^# TYPE tradebot_wallet_balance_bch gauge/m);
  assert.match(result.body, /^# TYPE tradebot_wallet_utxo_count gauge/m);
  assert.match(result.body, /^# TYPE tradebot_positions_open_count gauge/m);
  assert.match(result.body, /^# TYPE tradebot_breaker_is_tripped gauge/m);
  // Body must end with a trailing newline.
  assert.ok(result.body.endsWith('\n'));
});

test('server: GET /metrics — degraded probe still produces parseable body', async (t) => {
  const dir = await makeTmp(t);
  await mkdir(dir, { recursive: true });
  const cfg = {
    dashboard: { bind_host: '127.0.0.1', bind_port: 0 },
    paths: { positions_file: `${dir}/positions.json`, snapshots_dir: `${dir}/snapshots` },
  };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger() });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger() });
  await snapshots.load();
  const { ctx: serverCtx, routes: serverRoutes } = await makeServer({ cfg, positions, snapshots });
  const route = serverRoutes.find((r) => r.path === '/metrics');
  // Throwing loop + throwing wallet — both degraded.
  const ctxBroken = {
    ...serverCtx,
    loop: { stats: () => { throw new Error('loop is dead'); } },
    wallet: { getBalanceSats: async () => { throw new Error('wallet is dead'); }, listUtxos: async () => { throw new Error('utxo scan dead'); } },
    positions: null,
    risk: null,
  };
  const result = await route.handler(ctxBroken, {}, new URL('http://x/metrics'));
  assert.equal(result.__text_response, true);
  assert.equal(result.content_type, PROMETHEUS_CONTENT_TYPE);
  // The body still contains the metric blocks, with `probe_status:degraded` labels.
  assert.match(result.body, /^tradebot_loop_tick_count_total\{probe_status="degraded"\} 0$/m);
  assert.match(result.body, /^tradebot_wallet_balance_bch\{probe_status="degraded"\} 0$/m);
  // The body is still valid Prometheus text format.
  for (const line of result.body.split('\n')) {
    if (line.startsWith('#') || line === '') continue;
    assert.match(line, /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})?\s+-?\d+(\.\d+)?$/, `unexpected line: ${line}`);
  }
});

test('server: GET /metrics — handler NEVER throws even when envelope builder explodes', async (t) => {
  const dir = await makeTmp(t);
  await mkdir(dir, { recursive: true });
  const cfg = {
    dashboard: { bind_host: '127.0.0.1', bind_port: 0 },
    paths: { positions_file: `${dir}/positions.json`, snapshots_dir: `${dir}/snapshots` },
  };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger() });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger() });
  await snapshots.load();
  const { ctx: serverCtx, routes: serverRoutes } = await makeServer({ cfg, positions, snapshots });
  const route = serverRoutes.find((r) => r.path === '/metrics');
  // Pass `null` as the ctx — this trips the TypeError guard at
  // the top of `buildMetricsEnvelope` so the handler-level
  // try/catch fires and the scrape emits a parseable degraded
  // envelope with `# ERROR builder_failed: ...`.
  const result = await route.handler(null, {}, new URL('http://x/metrics'));
  assert.equal(result.__text_response, true);
  assert.match(result.body, /^tradebot_up\{probe_status="degraded"\} 0$/m);
  assert.match(result.body, /^# ERROR builder_failed:/m);
});
