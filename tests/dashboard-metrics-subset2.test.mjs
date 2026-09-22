#!/usr/bin/env node
// tests/dashboard-metrics-subset2.test.mjs
//
// T79 subset 2 — unit + integration tests for
// `src/dashboard/metrics-subset2.mjs` (per-token counters,
// scoring-gate hit counters, tick-duration summary) and the
// `subset2Probes` seam in `src/dashboard/metrics.mjs` +
// `src/dashboard/server.mjs`. Run with:
//
//   node --test tests/dashboard-metrics-subset2.test.mjs
//
// Coverage:
//   1. classifyExitOutcome (12)
//   2. partitionEventsForMetrics (8)
//   3. aggregatePerTokenCounts (10)
//   4. aggregateScoringGateCounts (7)
//   5. summarizeTickDurations (8)
//   6. renderPerTokenMetricBlocks (5)
//   7. renderScoringGateMetricBlocks (4)
//   8. renderTickDurationMetricBlocks (4)
//   9. gatherSubset2Probes (5)
//  10. gatherSubset2ProbesFromCtx (6)
//  11. createSubset2ProbeCache (6)
//  12. clampMetricsPerTokenCacheMs + clampMetricsHistoryLimit (10)
//  13. buildMetricsEnvelope subset2 seam (5)
//  14. /metrics HTTP integration with subset2 cache (4)
//
// Total: ~94 tests.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyExitOutcome,
  partitionEventsForMetrics,
  aggregatePerTokenCounts,
  aggregateScoringGateCounts,
  summarizeTickDurations,
  renderPerTokenMetricBlocks,
  renderScoringGateMetricBlocks,
  renderTickDurationMetricBlocks,
  gatherSubset2Probes,
  gatherSubset2ProbesFromCtx,
  createSubset2ProbeCache,
  clampMetricsPerTokenCacheMs,
  clampMetricsHistoryLimit,
  DEFAULT_METRICS_PER_TOKEN_CACHE_MS,
  DEFAULT_METRICS_HISTORY_LIMIT,
  METRICS_SUBSET2_SCHEMA,
} from '../src/dashboard/metrics-subset2.mjs';
import {
  buildMetricsEnvelope,
  formatPrometheusText,
} from '../src/dashboard/metrics.mjs';
import { createDashboardServer, _internals } from '../src/dashboard/server.mjs';

// ─────────────────────────────────────────────────────────────────────
//  classifyExitOutcome
// ─────────────────────────────────────────────────────────────────────
describe('metrics-subset2: classifyExitOutcome', () => {
  it('returns win for positive bigint', () => {
    assert.equal(classifyExitOutcome(101n), 'win');
    assert.equal(classifyExitOutcome(1000n), 'win');
  });
  it('returns loss for negative bigint', () => {
    assert.equal(classifyExitOutcome(-101n), 'loss');
    assert.equal(classifyExitOutcome(-1000n), 'loss');
  });
  it('returns breakeven for null/undefined/0/±100', () => {
    assert.equal(classifyExitOutcome(null), 'breakeven');
    assert.equal(classifyExitOutcome(undefined), 'breakeven');
    assert.equal(classifyExitOutcome(0n), 'breakeven');
    assert.equal(classifyExitOutcome(100n), 'breakeven');
    assert.equal(classifyExitOutcome(-100n), 'breakeven');
  });
  it('handles string numbers', () => {
    assert.equal(classifyExitOutcome('500'), 'win');
    assert.equal(classifyExitOutcome('-500'), 'loss');
    assert.equal(classifyExitOutcome('not a number'), 'breakeven');
    assert.equal(classifyExitOutcome(''), 'breakeven');
  });
  it('handles finite numbers', () => {
    assert.equal(classifyExitOutcome(123.45), 'win');
    assert.equal(classifyExitOutcome(-999.99), 'loss');
    assert.equal(classifyExitOutcome(50), 'breakeven'); // within ±100 window
  });
  it('returns breakeven for NaN/Infinity/non-numbers', () => {
    assert.equal(classifyExitOutcome(NaN), 'breakeven');
    assert.equal(classifyExitOutcome(Infinity), 'breakeven');
    assert.equal(classifyExitOutcome(-Infinity), 'breakeven');
    assert.equal(classifyExitOutcome({}), 'breakeven');
    assert.equal(classifyExitOutcome([]), 'breakeven');
    assert.equal(classifyExitOutcome(true), 'breakeven');
  });
});

// ─────────────────────────────────────────────────────────────────────
//  partitionEventsForMetrics
// ─────────────────────────────────────────────────────────────────────
describe('metrics-subset2: partitionEventsForMetrics', () => {
  it('returns empty buckets for non-array', () => {
    const out = partitionEventsForMetrics(null);
    assert.equal(out.entries.length, 0);
    assert.equal(out.exits.length, 0);
    assert.equal(out._dropped, 0);
  });
  it('returns empty buckets for empty array', () => {
    const out = partitionEventsForMetrics([]);
    assert.equal(out.entries.length, 0);
    assert.equal(out.exits.length, 0);
  });
  it('partitions known kinds', () => {
    const events = [
      { kind: 'entry', token_id: 'aaa' },
      { kind: 'exit', token_id: 'bbb' },
      { kind: 'entry_skipped', token_id: 'ccc', skip_kind: 'already_open' },
      { kind: 'entry_rejected', token_id: 'ddd', reject_kind: 'foo' },
      { kind: 'exit_skipped', token_id: 'eee', reason: 'no_exit_condition' },
      { kind: 'exit_blocked_by_profit_target', token_id: 'fff', reason: 'profit_target_block' },
      { kind: 'tick', duration_ms: 100 },
    ];
    const out = partitionEventsForMetrics(events);
    assert.equal(out.entries.length, 1);
    assert.equal(out.exits.length, 1);
    assert.equal(out.entrySkipped.length, 1);
    assert.equal(out.entryRejected.length, 1);
    assert.equal(out.exitSkipped.length, 1);
    assert.equal(out.exitBlockedByProfitTarget.length, 1);
    assert.equal(out.ticks.length, 1);
    assert.equal(out._dropped, 0);
  });
  it('drops events with non-string kind', () => {
    const events = [
      { kind: 42 },
      { kind: null },
      {},
      { kind: 'entry', token_id: 'aaa' },
    ];
    const out = partitionEventsForMetrics(events);
    assert.equal(out.entries.length, 1);
    assert.equal(out._dropped, 3);
  });
  it('drops events with malformed kind', () => {
    const events = [
      { kind: 'has space' },
      { kind: 'has!bang' },
      { kind: 'with\nnewline' },
      { kind: 'a'.repeat(100) },
    ];
    const out = partitionEventsForMetrics(events);
    assert.equal(out.entries.length, 0);
    assert.equal(out._dropped, 4);
  });
  it('skips other kinds without counting as dropped', () => {
    const events = [
      { kind: 'config_hot_reload' },
      { kind: 'research_cron_run' },
      { kind: 'entry', token_id: 'aaa' },
    ];
    const out = partitionEventsForMetrics(events);
    assert.equal(out.entries.length, 1);
    assert.equal(out._dropped, 0);
  });
  it('skips non-object events without counting as dropped', () => {
    const events = [null, undefined, 'string', 42];
    const out = partitionEventsForMetrics(events);
    assert.equal(out.entries.length, 0);
    assert.equal(out._dropped, 4);
  });
  it('preserves insertion order', () => {
    const events = [
      { kind: 'entry', token_id: 'aaa' },
      { kind: 'entry', token_id: 'bbb' },
      { kind: 'entry', token_id: 'ccc' },
    ];
    const out = partitionEventsForMetrics(events);
    assert.deepEqual(out.entries.map((e) => e.token_id), ['aaa', 'bbb', 'ccc']);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  aggregatePerTokenCounts
// ─────────────────────────────────────────────────────────────────────
describe('metrics-subset2: aggregatePerTokenCounts', () => {
  it('returns empty map for no entries/exits', () => {
    const partitioned = partitionEventsForMetrics([]);
    const out = aggregatePerTokenCounts(partitioned);
    assert.equal(out.byTokenId.size, 0);
    assert.equal(out._dropped, 0);
  });
  it('counts entries per token', () => {
    const partitioned = partitionEventsForMetrics([
      { kind: 'entry', token_id: 'aaa' },
      { kind: 'entry', token_id: 'aaa' },
      { kind: 'entry', token_id: 'bbb' },
    ]);
    const out = aggregatePerTokenCounts(partitioned);
    assert.equal(out.byTokenId.get('aaa').entryCount, 2);
    assert.equal(out.byTokenId.get('bbb').entryCount, 1);
  });
  it('drops entries with missing token_id', () => {
    const partitioned = partitionEventsForMetrics([
      { kind: 'entry' },
      { kind: 'entry', token_id: 42 },
      { kind: 'entry', token_id: '' },
      { kind: 'entry', token_id: 'aaa' },
    ]);
    const out = aggregatePerTokenCounts(partitioned);
    assert.equal(out.byTokenId.size, 1);
    assert.equal(out.byTokenId.get('aaa').entryCount, 1);
    assert.equal(out._dropped, 3);
  });
  it('drops entries with oversized token_id', () => {
    const partitioned = partitionEventsForMetrics([
      { kind: 'entry', token_id: 'a'.repeat(200) },
    ]);
    const out = aggregatePerTokenCounts(partitioned);
    assert.equal(out.byTokenId.size, 0);
    assert.equal(out._dropped, 1);
  });
  it('preserves the first seen symbol', () => {
    const partitioned = partitionEventsForMetrics([
      { kind: 'entry', token_id: 'aaa', symbol: 'TOK' },
      { kind: 'entry', token_id: 'aaa', symbol: 'TOK2' },
    ]);
    const out = aggregatePerTokenCounts(partitioned);
    assert.equal(out.byTokenId.get('aaa').symbol, 'TOK');
  });
  it('aggregates exits by exit_kind', () => {
    const partitioned = partitionEventsForMetrics([
      { kind: 'exit', token_id: 'aaa', exit_kind: 'time_stop', realized_pnl_sats: '500' },
      { kind: 'exit', token_id: 'aaa', exit_kind: 'time_stop', realized_pnl_sats: '-300' },
      { kind: 'exit', token_id: 'aaa', exit_kind: 'take_profit', realized_pnl_sats: '1000' },
    ]);
    const out = aggregatePerTokenCounts(partitioned);
    const rec = out.byTokenId.get('aaa');
    assert.equal(rec.exitCountsByOutcome.get('time_stop'), 2);
    assert.equal(rec.exitCountsByOutcome.get('take_profit'), 1);
    assert.equal(rec.realizedPnlSats, 1200n);
  });
  it('falls back to PnL classification when exit_kind is missing', () => {
    const partitioned = partitionEventsForMetrics([
      { kind: 'exit', token_id: 'aaa', realized_pnl_sats: '500' },
      { kind: 'exit', token_id: 'aaa', realized_pnl_sats: '-500' },
    ]);
    const out = aggregatePerTokenCounts(partitioned);
    const rec = out.byTokenId.get('aaa');
    assert.equal(rec.exitCountsByOutcome.get('win'), 1);
    assert.equal(rec.exitCountsByOutcome.get('loss'), 1);
  });
  it('ignores non-bigint PnL', () => {
    const partitioned = partitionEventsForMetrics([
      { kind: 'exit', token_id: 'aaa', realized_pnl_sats: 'not a number' },
      { kind: 'exit', token_id: 'aaa', realized_pnl_sats: null },
    ]);
    const out = aggregatePerTokenCounts(partitioned);
    assert.equal(out.byTokenId.get('aaa').realizedPnlSats, 0n);
  });
  it('handles bigint PnL', () => {
    const partitioned = partitionEventsForMetrics([
      { kind: 'exit', token_id: 'aaa', realized_pnl_sats: 500n },
      { kind: 'exit', token_id: 'aaa', realized_pnl_sats: -200n },
    ]);
    const out = aggregatePerTokenCounts(partitioned);
    assert.equal(out.byTokenId.get('aaa').realizedPnlSats, 300n);
  });
  it('handles floating-point PnL', () => {
    const partitioned = partitionEventsForMetrics([
      { kind: 'exit', token_id: 'aaa', realized_pnl_sats: 500.7 },
      { kind: 'exit', token_id: 'aaa', realized_pnl_sats: -200.3 },
    ]);
    const out = aggregatePerTokenCounts(partitioned);
    assert.equal(out.byTokenId.get('aaa').realizedPnlSats, 300n);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  aggregateScoringGateCounts
// ─────────────────────────────────────────────────────────────────────
describe('metrics-subset2: aggregateScoringGateCounts', () => {
  it('returns empty map for no skip events', () => {
    const partitioned = partitionEventsForMetrics([]);
    const out = aggregateScoringGateCounts(partitioned);
    assert.equal(out.byKind.size, 0);
    assert.equal(out.totals, 0);
  });
  it('counts entry_skipped by skip_kind', () => {
    const partitioned = partitionEventsForMetrics([
      { kind: 'entry_skipped', token_id: 'aaa', skip_kind: 'too_close_to_high' },
      { kind: 'entry_skipped', token_id: 'bbb', skip_kind: 'too_close_to_high' },
      { kind: 'entry_skipped', token_id: 'ccc', skip_kind: 'rug_pattern_detected' },
    ]);
    const out = aggregateScoringGateCounts(partitioned);
    assert.equal(out.totals, 3);
    assert.equal(out.byKind.get('entry_skipped').get('too_close_to_high'), 2);
    assert.equal(out.byKind.get('entry_skipped').get('rug_pattern_detected'), 1);
  });
  it('falls back to reason field when skip_kind missing', () => {
    const partitioned = partitionEventsForMetrics([
      { kind: 'entry_skipped', token_id: 'aaa', reason: 'no price evidence' },
    ]);
    const out = aggregateScoringGateCounts(partitioned);
    assert.equal(out.byKind.get('entry_skipped').get('no price evidence'), 1);
  });
  it('counts entry_rejected by reject_kind', () => {
    const partitioned = partitionEventsForMetrics([
      { kind: 'entry_rejected', token_id: 'aaa', reject_kind: 'already_open' },
    ]);
    const out = aggregateScoringGateCounts(partitioned);
    assert.equal(out.byKind.get('entry_rejected').get('already_open'), 1);
  });
  it('uses no_exit_condition fallback for exit_skipped', () => {
    const partitioned = partitionEventsForMetrics([
      { kind: 'exit_skipped', position_id: 'p1' },
    ]);
    const out = aggregateScoringGateCounts(partitioned);
    assert.equal(out.byKind.get('exit_skipped').get('no_exit_condition'), 1);
  });
  it('uses profit_target_block fallback for exit_blocked_by_profit_target', () => {
    const partitioned = partitionEventsForMetrics([
      { kind: 'exit_blocked_by_profit_target', position_id: 'p1' },
    ]);
    const out = aggregateScoringGateCounts(partitioned);
    assert.equal(out.byKind.get('exit_blocked_by_profit_target').get('profit_target_block'), 1);
  });
  it('strips newlines from reasons', () => {
    const partitioned = partitionEventsForMetrics([
      { kind: 'entry_skipped', token_id: 'aaa', reason: 'has\nnewline' },
    ]);
    const out = aggregateScoringGateCounts(partitioned);
    const reasons = Array.from(out.byKind.get('entry_skipped').keys());
    assert.equal(reasons[0], 'has newline');
  });
});

// ─────────────────────────────────────────────────────────────────────
//  summarizeTickDurations
// ─────────────────────────────────────────────────────────────────────
describe('metrics-subset2: summarizeTickDurations', () => {
  it('returns empty summary for no ticks', () => {
    const s = summarizeTickDurations([]);
    assert.deepEqual(s, { count: 0, mean_ms: 0, max_ms: 0, last_ms: 0, p50_ms: 0, p95_ms: 0 });
  });
  it('returns empty summary for non-array', () => {
    const s = summarizeTickDurations(null);
    assert.deepEqual(s, { count: 0, mean_ms: 0, max_ms: 0, last_ms: 0, p50_ms: 0, p95_ms: 0 });
  });
  it('computes mean/max/last/p50/p95', () => {
    const ticks = Array.from({ length: 100 }, (_, i) => ({ duration_ms: i + 1 }));
    const s = summarizeTickDurations(ticks);
    assert.equal(s.count, 100);
    assert.equal(s.max_ms, 100);
    assert.equal(s.mean_ms, 51); // (1+100)/2 rounded
    assert.equal(s.last_ms, 100);
    assert.ok(s.p50_ms >= 49 && s.p50_ms <= 51);
    assert.ok(s.p95_ms >= 94 && s.p95_ms <= 96);
  });
  it('handles a single tick', () => {
    const s = summarizeTickDurations([{ duration_ms: 42 }]);
    assert.equal(s.count, 1);
    assert.equal(s.max_ms, 42);
    assert.equal(s.mean_ms, 42);
    assert.equal(s.p50_ms, 42);
    assert.equal(s.p95_ms, 42);
  });
  it('coerces string durations', () => {
    const s = summarizeTickDurations([{ duration_ms: '42' }, { duration_ms: '58' }]);
    assert.equal(s.count, 2);
    assert.equal(s.mean_ms, 50);
  });
  it('skips ticks with invalid duration', () => {
    const s = summarizeTickDurations([
      { duration_ms: 42 },
      { duration_ms: 'not a number' },
      {},
      { duration_ms: null },
      { duration_ms: 99 },
    ]);
    assert.equal(s.count, 2);
    assert.equal(s.max_ms, 99);
  });
  it('clamps negative durations to 0', () => {
    const s = summarizeTickDurations([{ duration_ms: -5 }]);
    assert.equal(s.max_ms, 0);
  });
  it('reports last_ms from final valid tick', () => {
    const s = summarizeTickDurations([
      { duration_ms: 1 },
      { duration_ms: 'invalid' },
      { duration_ms: 99 },
    ]);
    assert.equal(s.last_ms, 99);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  renderPerTokenMetricBlocks
// ─────────────────────────────────────────────────────────────────────
describe('metrics-subset2: renderPerTokenMetricBlocks', () => {
  it('renders three blocks even with empty map', () => {
    const blocks = renderPerTokenMetricBlocks({ byTokenId: new Map(), _dropped: 0 });
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].name, 'tradebot_token_entry_count_total');
    assert.equal(blocks[1].name, 'tradebot_token_exit_count_total');
    assert.equal(blocks[2].name, 'tradebot_token_realized_pnl_sats_total');
    assert.equal(blocks[0].samples.length, 1);
  });
  it('renders per-token entry samples', () => {
    const byTokenId = new Map([
      ['aaa', { entryCount: 2, exitCountsByOutcome: new Map(), realizedPnlSats: 0n, symbol: 'TOK' }],
      ['bbb', { entryCount: 1, exitCountsByOutcome: new Map(), realizedPnlSats: 0n, symbol: 'FOO' }],
    ]);
    const blocks = renderPerTokenMetricBlocks({ byTokenId });
    const entryBlock = blocks[0];
    assert.equal(entryBlock.samples.length, 2);
    // Samples sorted by token_id (lexicographic): aaa, bbb
    assert.equal(entryBlock.samples[0].labels.token_id, 'aaa');
    assert.equal(entryBlock.samples[0].value, 2);
    assert.equal(entryBlock.samples[1].labels.token_id, 'bbb');
    assert.equal(entryBlock.samples[1].value, 1);
  });
  it('renders exit samples with outcome label', () => {
    const byTokenId = new Map([
      ['aaa', {
        entryCount: 0,
        exitCountsByOutcome: new Map([['time_stop', 2], ['take_profit', 1]]),
        realizedPnlSats: 500n,
        symbol: 'TOK',
      }],
    ]);
    const blocks = renderPerTokenMetricBlocks({ byTokenId });
    const exitBlock = blocks[1];
    assert.equal(exitBlock.samples.length, 2);
    // Samples sorted by outcome: take_profit, time_stop
    assert.equal(exitBlock.samples[0].labels.outcome, 'take_profit');
    assert.equal(exitBlock.samples[0].value, 1);
    assert.equal(exitBlock.samples[1].labels.outcome, 'time_stop');
    assert.equal(exitBlock.samples[1].value, 2);
  });
  it('renders realized-PnL as stringified bigint', () => {
    const byTokenId = new Map([
      ['aaa', { entryCount: 1, exitCountsByOutcome: new Map(), realizedPnlSats: 123456789012345n, symbol: 'TOK' }],
    ]);
    const blocks = renderPerTokenMetricBlocks({ byTokenId });
    const pnlBlock = blocks[2];
    assert.equal(pnlBlock.samples.length, 1);
    assert.equal(pnlBlock.samples[0].value, '123456789012345');
    assert.equal(typeof pnlBlock.samples[0].value, 'string');
  });
  it('renders negative PnL', () => {
    const byTokenId = new Map([
      ['aaa', { entryCount: 0, exitCountsByOutcome: new Map(), realizedPnlSats: -500n, symbol: 'TOK' }],
    ]);
    const blocks = renderPerTokenMetricBlocks({ byTokenId });
    assert.equal(blocks[2].samples[0].value, '-500');
  });
});

// ─────────────────────────────────────────────────────────────────────
//  renderScoringGateMetricBlocks
// ─────────────────────────────────────────────────────────────────────
describe('metrics-subset2: renderScoringGateMetricBlocks', () => {
  it('renders single block even with empty map', () => {
    const blocks = renderScoringGateMetricBlocks({ byKind: new Map(), totals: 0, _dropped: 0 });
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].name, 'tradebot_scoring_gate_skipped_total');
    assert.equal(blocks[0].samples.length, 1);
  });
  it('renders kind+reason samples sorted', () => {
    const byKind = new Map([
      ['entry_skipped', new Map([['too_close_to_high', 5], ['rug_pattern_detected', 1]])],
      ['entry_rejected', new Map([['already_open', 3]])],
    ]);
    const blocks = renderScoringGateMetricBlocks({ byKind });
    const samples = blocks[0].samples;
    assert.equal(samples.length, 3);
    // Kinds sorted: entry_rejected < entry_skipped
    assert.equal(samples[0].labels.kind, 'entry_rejected');
    assert.equal(samples[0].labels.reason, 'already_open');
    assert.equal(samples[0].value, 3);
    // entry_skipped reasons sorted: rug_pattern_detected < too_close_to_high
    assert.equal(samples[1].labels.kind, 'entry_skipped');
    assert.equal(samples[1].labels.reason, 'rug_pattern_detected');
    assert.equal(samples[2].labels.reason, 'too_close_to_high');
  });
  it('renders zero samples on missing input', () => {
    const blocks = renderScoringGateMetricBlocks(null);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].samples[0].value, 0);
  });
  it('handles only one kind', () => {
    const byKind = new Map([['exit_skipped', new Map([['no_exit_condition', 10]])]]);
    const blocks = renderScoringGateMetricBlocks({ byKind });
    assert.equal(blocks[0].samples.length, 1);
    assert.equal(blocks[0].samples[0].labels.kind, 'exit_skipped');
    assert.equal(blocks[0].samples[0].value, 10);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  renderTickDurationMetricBlocks
// ─────────────────────────────────────────────────────────────────────
describe('metrics-subset2: renderTickDurationMetricBlocks', () => {
  it('renders 6 gauges even with empty summary', () => {
    const blocks = renderTickDurationMetricBlocks({});
    assert.equal(blocks.length, 6);
    assert.equal(blocks[0].name, 'tradebot_loop_tick_duration_last_ms');
    assert.equal(blocks[1].name, 'tradebot_loop_tick_duration_mean_ms');
    assert.equal(blocks[2].name, 'tradebot_loop_tick_duration_p50_ms');
    assert.equal(blocks[3].name, 'tradebot_loop_tick_duration_p95_ms');
    assert.equal(blocks[4].name, 'tradebot_loop_tick_duration_max_ms');
    assert.equal(blocks[5].name, 'tradebot_loop_tick_duration_observed_total');
    for (const b of blocks) assert.equal(b.samples[0].value, 0);
  });
  it('passes summary values through', () => {
    const s = { count: 5, mean_ms: 100, max_ms: 500, last_ms: 200, p50_ms: 80, p95_ms: 450 };
    const blocks = renderTickDurationMetricBlocks(s);
    assert.equal(blocks[0].samples[0].value, 200);
    assert.equal(blocks[1].samples[0].value, 100);
    assert.equal(blocks[2].samples[0].value, 80);
    assert.equal(blocks[3].samples[0].value, 450);
    assert.equal(blocks[4].samples[0].value, 500);
    assert.equal(blocks[5].samples[0].value, 5);
  });
  it('clamps NaN/Infinity to 0', () => {
    const s = { count: NaN, mean_ms: Infinity, max_ms: -Infinity, last_ms: 'bad', p50_ms: NaN, p95_ms: undefined };
    const blocks = renderTickDurationMetricBlocks(s);
    for (const b of blocks) assert.equal(b.samples[0].value, 0);
  });
  it('handles null input', () => {
    const blocks = renderTickDurationMetricBlocks(null);
    assert.equal(blocks.length, 6);
    for (const b of blocks) assert.equal(b.samples[0].value, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  gatherSubset2Probes
// ─────────────────────────────────────────────────────────────────────
describe('metrics-subset2: gatherSubset2Probes', () => {
  it('returns ok status for empty events', () => {
    const out = gatherSubset2Probes({ events: [] });
    assert.equal(out.probeStatus, 'ok');
    assert.equal(out.perToken.totals.tokens, 0);
    assert.equal(out.scoringGate.totals, 0);
    assert.equal(out.tickDuration.summary.count, 0);
  });
  it('returns ok status for non-array events', () => {
    const out = gatherSubset2Probes({ events: null });
    assert.equal(out.probeStatus, 'ok');
    assert.equal(out.perToken.totals.tokens, 0);
  });
  it('aggregates real events', () => {
    const events = [
      { kind: 'entry', token_id: 'aaa', symbol: 'TOK' },
      { kind: 'exit', token_id: 'aaa', symbol: 'TOK', exit_kind: 'time_stop', realized_pnl_sats: '500' },
      { kind: 'entry', token_id: 'bbb', symbol: 'TOK2' },
      { kind: 'entry_skipped', token_id: 'ccc', skip_kind: 'too_close_to_high' },
      { kind: 'tick', duration_ms: 100 },
      { kind: 'tick', duration_ms: 200 },
    ];
    const out = gatherSubset2Probes({ events });
    assert.equal(out.probeStatus, 'ok');
    assert.equal(out.perToken.totals.tokens, 2); // aaa, bbb
    assert.equal(out.scoringGate.totals, 1);
    assert.equal(out.tickDuration.summary.count, 2);
    assert.equal(out.tickDuration.summary.max_ms, 200);
  });
  it('reports dropped count', () => {
    const events = [
      { kind: 'entry', token_id: 'aaa' },
      { kind: 'garbage' },
      { kind: null },
    ];
    const out = gatherSubset2Probes({ events });
    assert.equal(out.perToken.totals.tokens, 1);
    assert.equal(out.perToken.totals.dropped, 0); // partition dropped counts are separate
    assert.equal(out.scoringGate.totals, 0);
  });
  it('returns metrics blocks for all three probes', () => {
    const out = gatherSubset2Probes({ events: [] });
    assert.equal(out.perToken.metrics.length, 3);
    assert.equal(out.scoringGate.metrics.length, 1);
    assert.equal(out.tickDuration.metrics.length, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  gatherSubset2ProbesFromCtx
// ─────────────────────────────────────────────────────────────────────
describe('metrics-subset2: gatherSubset2ProbesFromCtx', () => {
  it('returns unconfigured for missing ctx', async () => {
    const out = await gatherSubset2ProbesFromCtx({ ctx: null });
    assert.equal(out.probeStatus, 'unconfigured');
    assert.equal(out.error, null);
    // Even unconfigured returns valid metric blocks.
    assert.equal(out.perToken.metrics.length, 3);
    assert.equal(out.scoringGate.metrics.length, 1);
    assert.equal(out.tickDuration.metrics.length, 6);
  });
  it('returns unconfigured for ctx without historyReader', async () => {
    const out = await gatherSubset2ProbesFromCtx({ ctx: {} });
    assert.equal(out.probeStatus, 'unconfigured');
  });
  it('reads from historyReader', async () => {
    const events = [
      { kind: 'entry', token_id: 'aaa' },
      { kind: 'exit', token_id: 'aaa', exit_kind: 'time_stop', realized_pnl_sats: '100' },
    ];
    const ctx = {
      historyReader: {
        async read() {
          return { events, errors: [] };
        },
      },
    };
    const out = await gatherSubset2ProbesFromCtx({ ctx });
    assert.equal(out.probeStatus, 'ok');
    assert.equal(out.perToken.totals.tokens, 1);
    assert.equal(out.scoringGate.totals, 0);
  });
  it('passes opts.historyLimit to reader', async () => {
    let calledWith = null;
    const ctx = {
      historyReader: {
        async read(opts) {
          calledWith = opts;
          return { events: [], errors: [] };
        },
      },
    };
    await gatherSubset2ProbesFromCtx({ ctx, opts: { historyLimit: 123 } });
    assert.equal(calledWith.limit, 123);
  });
  it('returns degraded when historyReader.read throws', async () => {
    const ctx = {
      historyReader: {
        async read() {
          throw new Error('disk full');
        },
      },
    };
    const out = await gatherSubset2ProbesFromCtx({ ctx });
    assert.equal(out.probeStatus, 'degraded');
    assert.match(out.error, /disk full/);
  });
  it('uses default limit when opts.historyLimit is non-number', async () => {
    let calledWith = null;
    const ctx = {
      historyReader: {
        async read(opts) {
          calledWith = opts;
          return { events: [], errors: [] };
        },
      },
    };
    await gatherSubset2ProbesFromCtx({ ctx, opts: { historyLimit: 'bad' } });
    assert.equal(calledWith.limit, DEFAULT_METRICS_HISTORY_LIMIT);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  createSubset2ProbeCache
// ─────────────────────────────────────────────────────────────────────
describe('metrics-subset2: createSubset2ProbeCache', () => {
  it('returns a cache object', () => {
    const cache = createSubset2ProbeCache({ ctx: null });
    assert.equal(typeof cache.gather, 'function');
    assert.equal(typeof cache.invalidate, 'function');
    assert.equal(typeof cache.stats, 'function');
  });
  it('caches results within TTL', async () => {
    let calls = 0;
    const ctx = {
      historyReader: {
        async read() {
          calls += 1;
          return { events: [{ kind: 'entry', token_id: 'aaa' }], errors: [] };
        },
      },
    };
    const cache = createSubset2ProbeCache({ ctx, cacheMs: 60_000 });
    await cache.gather();
    await cache.gather();
    await cache.gather();
    assert.equal(calls, 1);
    const s = cache.stats();
    assert.equal(s.cache_hits, 2);
    assert.equal(s.cache_misses, 1);
  });
  it('invalidates on invalidate()', async () => {
    let calls = 0;
    const ctx = {
      historyReader: {
        async read() {
          calls += 1;
          return { events: [], errors: [] };
        },
      },
    };
    const cache = createSubset2ProbeCache({ ctx, cacheMs: 60_000 });
    await cache.gather();
    cache.invalidate();
    await cache.gather();
    assert.equal(calls, 2);
  });
  it('refreshes after TTL expiry', async () => {
    let calls = 0;
    const ctx = {
      historyReader: {
        async read() {
          calls += 1;
          return { events: [], errors: [] };
        },
      },
    };
    let now = 1000;
    const cache = createSubset2ProbeCache({ ctx, cacheMs: 100, nowMs: () => now });
    await cache.gather();  // t=1000 -> call 1
    now = 1050;
    await cache.gather();  // t=1050, age=50 < 100 -> cached (no new call)
    assert.equal(calls, 1);
    now = 1100;
    await cache.gather();  // t=1100, age=100, not < 100 -> miss -> call 2
    assert.equal(calls, 2);
  });
  it('cacheMs=0 disables caching', async () => {
    let calls = 0;
    const ctx = {
      historyReader: {
        async read() {
          calls += 1;
          return { events: [], errors: [] };
        },
      },
    };
    const cache = createSubset2ProbeCache({ ctx, cacheMs: 0 });
    await cache.gather();
    await cache.gather();
    await cache.gather();
    assert.equal(calls, 3);
  });
  it('uses default cacheMs when not provided', async () => {
    const cache = createSubset2ProbeCache({ ctx: null });
    const s = cache.stats();
    assert.equal(s.cache_hits, 0);
    assert.equal(s.cache_misses, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  clampMetricsPerTokenCacheMs + clampMetricsHistoryLimit
// ─────────────────────────────────────────────────────────────────────
describe('metrics-subset2: clamp helpers', () => {
  it('clampMetricsPerTokenCacheMs returns default for non-number', () => {
    assert.equal(clampMetricsPerTokenCacheMs(null), DEFAULT_METRICS_PER_TOKEN_CACHE_MS);
    assert.equal(clampMetricsPerTokenCacheMs(undefined), DEFAULT_METRICS_PER_TOKEN_CACHE_MS);
    assert.equal(clampMetricsPerTokenCacheMs('500'), DEFAULT_METRICS_PER_TOKEN_CACHE_MS);
    assert.equal(clampMetricsPerTokenCacheMs(NaN), DEFAULT_METRICS_PER_TOKEN_CACHE_MS);
    assert.equal(clampMetricsPerTokenCacheMs(Infinity), DEFAULT_METRICS_PER_TOKEN_CACHE_MS);
  });
  it('clampMetricsPerTokenCacheMs returns default for negative', () => {
    assert.equal(clampMetricsPerTokenCacheMs(-100), DEFAULT_METRICS_PER_TOKEN_CACHE_MS);
  });
  it('clampMetricsPerTokenCacheMs honors 0 (disabled caching)', () => {
    assert.equal(clampMetricsPerTokenCacheMs(0), 0);
  });
  it('clampMetricsPerTokenCacheMs clamps above 600_000', () => {
    assert.equal(clampMetricsPerTokenCacheMs(1_000_000), 600_000);
  });
  it('clampMetricsPerTokenCacheMs floors fractional values', () => {
    assert.equal(clampMetricsPerTokenCacheMs(123.7), 123);
  });
  it('clampMetricsHistoryLimit returns default for non-number', () => {
    assert.equal(clampMetricsHistoryLimit(null), DEFAULT_METRICS_HISTORY_LIMIT);
    assert.equal(clampMetricsHistoryLimit(undefined), DEFAULT_METRICS_HISTORY_LIMIT);
    assert.equal(clampMetricsHistoryLimit('500'), DEFAULT_METRICS_HISTORY_LIMIT);
  });
  it('clampMetricsHistoryLimit clamps above 50_000', () => {
    assert.equal(clampMetricsHistoryLimit(100_000), 50_000);
  });
  it('clampMetricsHistoryLimit honors 0', () => {
    assert.equal(clampMetricsHistoryLimit(0), 0);
  });
  it('clampMetricsHistoryLimit returns default for negative', () => {
    assert.equal(clampMetricsHistoryLimit(-100), DEFAULT_METRICS_HISTORY_LIMIT);
  });
  it('clampMetricsHistoryLimit floors fractional values', () => {
    assert.equal(clampMetricsHistoryLimit(1000.9), 1000);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  buildMetricsEnvelope subset2 seam
// ─────────────────────────────────────────────────────────────────────
describe('buildMetricsEnvelope: subset2 seam', () => {
  const baseCtx = {
    loop: { stats: () => ({ running: false, tick_count: 0, last_tick_at_ms: 0, last_tick_duration_ms: 0, entry_attempt_count: 0, exit_attempt_count: 0, error_count: 0, rug_pattern_gate: { last_tick: {} } }) },
    risk: null,
    wallet: null,
    positions: { list: () => [] },
  };

  it('omits subset2 metrics when subset2Probes is not provided', async () => {
    const envelope = await buildMetricsEnvelope({ ctx: baseCtx });
    const names = envelope.metrics.map((m) => m.name);
    assert.ok(!names.includes('tradebot_token_entry_count_total'));
    assert.ok(!names.includes('tradebot_scoring_gate_skipped_total'));
    assert.ok(!names.includes('tradebot_loop_tick_duration_last_ms'));
  });

  it('includes subset2 metrics when subset2Probes is provided', async () => {
    const subset2Probes = {
      probeStatus: 'ok',
      error: null,
      perToken: {
        metrics: [{
          name: 'tradebot_token_entry_count_total',
          type: 'counter',
          help: 'test',
          samples: [{ labels: { token_id: 'aaa', symbol: 'TOK' }, value: 5 }],
        }],
        totals: { tokens: 1, dropped: 0 },
      },
      scoringGate: {
        metrics: [{
          name: 'tradebot_scoring_gate_skipped_total',
          type: 'counter',
          help: 'test',
          samples: [{ labels: { kind: 'entry_skipped', reason: 'already_open' }, value: 3 }],
        }],
        totals: 3,
        dropped: 0,
      },
      tickDuration: {
        metrics: [{
          name: 'tradebot_loop_tick_duration_last_ms',
          type: 'gauge',
          help: 'test',
          samples: [{ labels: {}, value: 100 }],
        }],
        summary: { count: 5, mean_ms: 100, max_ms: 200, last_ms: 150, p50_ms: 80, p95_ms: 180 },
      },
    };
    const envelope = await buildMetricsEnvelope({ ctx: baseCtx, subset2Probes });
    const names = envelope.metrics.map((m) => m.name);
    assert.ok(names.includes('tradebot_token_entry_count_total'));
    assert.ok(names.includes('tradebot_scoring_gate_skipped_total'));
    assert.ok(names.includes('tradebot_loop_tick_duration_last_ms'));
  });

  it('logs a structured warn when subset2Probes is degraded', async () => {
    const warnings = [];
    const ctx = { ...baseCtx, logger: { warn: (msg, data) => warnings.push({ msg, data }) } };
    const subset2Probes = { probeStatus: 'degraded', error: 'history read failed', perToken: { metrics: [] }, scoringGate: { metrics: [] }, tickDuration: { metrics: [] } };
    await buildMetricsEnvelope({ ctx, subset2Probes });
    const subset2Warn = warnings.find((w) => w.msg === 'dashboard.metrics.subset2.degraded');
    assert.ok(subset2Warn);
    assert.match(subset2Warn.data.error, /history read failed/);
  });

  it('does not log a warn when subset2Probes is ok', async () => {
    const warnings = [];
    const ctx = { ...baseCtx, logger: { warn: (msg) => warnings.push(msg) } };
    const subset2Probes = { probeStatus: 'ok', error: null, perToken: { metrics: [] }, scoringGate: { metrics: [] }, tickDuration: { metrics: [] } };
    await buildMetricsEnvelope({ ctx, subset2Probes });
    assert.equal(warnings.filter((m) => m === 'dashboard.metrics.subset2.degraded').length, 0);
  });

  it('renders to parseable Prometheus text when subset2 is wired', async () => {
    const subset2Probes = gatherSubset2Probes({ events: [
      { kind: 'entry', token_id: 'aaa', symbol: 'TOK' },
      { kind: 'entry_skipped', token_id: 'bbb', skip_kind: 'too_close_to_high' },
      { kind: 'tick', duration_ms: 100 },
    ] });
    const envelope = await buildMetricsEnvelope({ ctx: baseCtx, subset2Probes });
    const text = formatPrometheusText(envelope);
    assert.match(text, /tradebot_token_entry_count_total\{[^}]*token_id="aaa"[^}]*\} 1/);
    assert.match(text, /symbol="TOK"/);
    assert.match(text, /tradebot_scoring_gate_skipped_total\{kind="entry_skipped",reason="too_close_to_high"\} 1/);
    assert.match(text, /tradebot_loop_tick_duration_last_ms 100/);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  /metrics HTTP integration with subset2 cache
// ─────────────────────────────────────────────────────────────────────
describe('server: /metrics HTTP integration with subset2 cache', () => {
  // Build a minimal dashboard server with a fake historyReader.
  function buildTestServer(historyEvents, dashboardCfgOverride) {
    const cfg = {
      paths: {},
      scoring: {},
      dashboard: {
        bind_host: '127.0.0.1',
        bind_port: 0,
        ...(dashboardCfgOverride || {}),
      },
    };
    const positions = { list: () => [] };
    const snapshots = { readBack: () => [] };
    const historyReader = {
      async read() {
        return { events: historyEvents, errors: [] };
      },
    };
    return createDashboardServer({
      cfg,
      positions,
      snapshots,
      historyReader,
      logger: {
        info() {}, warn() {}, error() {}, debug() {},
      },
    });
  }

  it('returns 200 with subset2 metrics in the body', async () => {
    const server = buildTestServer([
      { kind: 'entry', token_id: 'aaa', symbol: 'TOK' },
      { kind: 'exit', token_id: 'aaa', symbol: 'TOK', exit_kind: 'time_stop', realized_pnl_sats: '500' },
      { kind: 'entry_skipped', token_id: 'bbb', skip_kind: 'too_close_to_high' },
      { kind: 'tick', duration_ms: 100 },
    ]);
    await server.start();
    const { port } = server.server.address();
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/plain.*version=0\.0\.4/);
    const text = await res.text();
    assert.match(text, /tradebot_token_entry_count_total\{[^}]*token_id="aaa"[^}]*\} 1/);
    assert.match(text, /tradebot_scoring_gate_skipped_total\{kind="entry_skipped",reason="too_close_to_high"\} 1/);
    assert.match(text, /tradebot_loop_tick_duration_last_ms 100/);
    server.server.close();
  });

  it('returns 200 with empty-but-valid subset2 metrics when historyReader returns no events', async () => {
    const server = buildTestServer([]);
    await server.start();
    const { port } = server.server.address();
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(res.status, 200);
    const text = await res.text();
    // The empty blocks still emit a single placeholder sample.
    assert.match(text, /tradebot_token_entry_count_total/);
    assert.match(text, /tradebot_scoring_gate_skipped_total/);
    assert.match(text, /tradebot_loop_tick_duration_last_ms/);
    server.server.close();
  });

  it('handles historyReader errors gracefully', async () => {
    const cfg = {
      paths: {},
      scoring: {},
      dashboard: { bind_host: '127.0.0.1', bind_port: 0 },
    };
    const positions = { list: () => [] };
    const snapshots = { readBack: () => [] };
    const historyReader = {
      async read() {
        throw new Error('test read failure');
      },
    };
    const server = createDashboardServer({
      cfg,
      positions,
      snapshots,
      historyReader,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    await server.start();
    const { port } = server.server.address();
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(res.status, 200);
    const text = await res.text();
    // Subset 2 still emits empty blocks — the probe is degraded
    // but the wire format stays parseable.
    assert.match(text, /tradebot_token_entry_count_total/);
    server.server.close();
  });

  it('honors dashboardCfg.metrics_per_token_cache_ms', async () => {
    const cfg = {
      paths: {},
      scoring: {},
      dashboard: { bind_host: '127.0.0.1', bind_port: 0, metrics_per_token_cache_ms: 60_000 },
    };
    const positions = { list: () => [] };
    const snapshots = { readBack: () => [] };
    let calls = 0;
    const historyReader = {
      async read() {
        calls += 1;
        return { events: [{ kind: 'entry', token_id: 'aaa' }], errors: [] };
      },
    };
    // Use a high TTL so the second scrape hits the cache.
    const server = createDashboardServer({
      cfg,
      positions,
      snapshots,
      historyReader,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    await server.start();
    const { port } = server.server.address();
    await fetch(`http://127.0.0.1:${port}/metrics`);
    await fetch(`http://127.0.0.1:${port}/metrics`);
    await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(calls, 1);
    server.server.close();
  });
});