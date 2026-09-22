// dashboard/tests/risk-panel-view.test.mjs
//
// T41: unit tests for the pure helpers exported from
// `src/views/risk-panel-helpers.mjs`. Mirrors the pattern used
// by `reasoning-view.test.mjs` + `proposals-view.test.mjs` —
// the .jsx holds the React component, the .mjs holds the
// Node-testable formatting + severity-bucket logic.
//
// Coverage:
//   • exposureSeverity — null / unknown / ok / caution / warn / critical
//   • dailyLossSeverity — profit / no-threshold / breached / ratio buckets
//   • drawdownSeverity — null / unknown / ok / caution / warn / critical
//   • severityClass + severityBarClass — bucket→Tailwind map
//   • severityBarPct — clamp to [0,100] + null tolerance
//   • formatBchAmount — null / NaN / zero / large
//   • formatSatsAmount — bigint / string / number / null / unparseable
//   • formatPctSigned — positive / negative / zero / null
//   • utilizationPct — null / number / out-of-range
//   • relativeTimeAgo — future / just-now / minutes / hours / days / null
//   • circuitBreakerSummary — null / idle / tripped with kind reason
import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert';

import {
  exposureSeverity,
  dailyLossSeverity,
  drawdownSeverity,
  severityClass,
  severityBarClass,
  severityBarPct,
  formatBchAmount,
  formatSatsAmount,
  formatPctSigned,
  utilizationPct,
  relativeTimeAgo,
  circuitBreakerSummary,
} from '../src/views/risk-panel-helpers.mjs';

// ─── exposureSeverity ──────────────────────────────────────────────

describe('exposureSeverity', () => {
  it('returns unknown for null/undefined/non-finite', () => {
    strictEqual(exposureSeverity(null), 'unknown');
    strictEqual(exposureSeverity(undefined), 'unknown');
    strictEqual(exposureSeverity(NaN), 'unknown');
    strictEqual(exposureSeverity('0.5'), 'unknown');
  });
  it('returns ok for utilization < 0.60', () => {
    strictEqual(exposureSeverity(0), 'ok');
    strictEqual(exposureSeverity(0.30), 'ok');
    strictEqual(exposureSeverity(0.59), 'ok');
  });
  it('returns caution for 0.60..0.79', () => {
    strictEqual(exposureSeverity(0.60), 'caution');
    strictEqual(exposureSeverity(0.75), 'caution');
  });
  it('returns warn for 0.80..0.94', () => {
    strictEqual(exposureSeverity(0.80), 'warn');
    strictEqual(exposureSeverity(0.94), 'warn');
  });
  it('returns critical for >= 0.95', () => {
    strictEqual(exposureSeverity(0.95), 'critical');
    strictEqual(exposureSeverity(1.0), 'critical');
    strictEqual(exposureSeverity(1.5), 'critical');
  });
});

// ─── dailyLossSeverity ─────────────────────────────────────────────

describe('dailyLossSeverity', () => {
  it('returns critical when limit_breached=true (regardless of numbers)', () => {
    strictEqual(dailyLossSeverity(0n, -0.005, true), 'critical');
  });
  it('returns ok for positive realized (a win)', () => {
    strictEqual(dailyLossSeverity(1000n, -0.005), 'ok');
    strictEqual(dailyLossSeverity(500000n, -0.005), 'ok');
  });
  it('returns ok when no threshold is configured', () => {
    strictEqual(dailyLossSeverity(-1000000n, null), 'ok');
    strictEqual(dailyLossSeverity(-1000000n, undefined), 'ok');
  });
  it('returns ok for invalid threshold (positive number / NaN)', () => {
    strictEqual(dailyLossSeverity(-1000000n, 0.005), 'ok');
    strictEqual(dailyLossSeverity(-1000000n, NaN), 'ok');
  });
  it('returns ok for < 30% of threshold', () => {
    // -100_000 sats / -500_000 sats (0.005 BCH) = 20% → ok
    strictEqual(dailyLossSeverity(-100000n, -0.005), 'ok');
  });
  it('returns caution for 30-59% of threshold', () => {
    // -200_000 / -500_000 = 40% → caution
    strictEqual(dailyLossSeverity(-200000n, -0.005), 'caution');
  });
  it('returns warn for 60-89% of threshold', () => {
    // -350_000 / -500_000 = 70% → warn
    strictEqual(dailyLossSeverity(-350000n, -0.005), 'warn');
  });
  it('returns critical for >= 90% of threshold', () => {
    strictEqual(dailyLossSeverity(-460000n, -0.005), 'critical');
    strictEqual(dailyLossSeverity(-500000n, -0.005), 'critical');
  });
  it('returns unknown for null/invalid realized', () => {
    strictEqual(dailyLossSeverity(null, -0.005), 'unknown');
    strictEqual(dailyLossSeverity('not-a-number', -0.005), 'unknown');
  });
  it('accepts string sats', () => {
    strictEqual(dailyLossSeverity('-100000', -0.005), 'ok');
    strictEqual(dailyLossSeverity('-500000', -0.005), 'critical');
  });
});

// ─── drawdownSeverity ──────────────────────────────────────────────

describe('drawdownSeverity', () => {
  it('returns unknown for null/invalid', () => {
    strictEqual(drawdownSeverity(null), 'unknown');
    strictEqual(drawdownSeverity(NaN), 'unknown');
  });
  it('returns ok for <= 0', () => {
    strictEqual(drawdownSeverity(0), 'ok');
    strictEqual(drawdownSeverity(-5), 'ok');
  });
  it('returns ok for 0-4.99%', () => {
    strictEqual(drawdownSeverity(4.99), 'ok');
  });
  it('returns caution for 5-14.99%', () => {
    strictEqual(drawdownSeverity(5), 'caution');
    strictEqual(drawdownSeverity(14), 'caution');
  });
  it('returns warn for 15-29.99%', () => {
    strictEqual(drawdownSeverity(15), 'warn');
    strictEqual(drawdownSeverity(29), 'warn');
  });
  it('returns critical for >= 30%', () => {
    strictEqual(drawdownSeverity(30), 'critical');
    strictEqual(drawdownSeverity(99.9), 'critical');
  });
});

// ─── severityClass / severityBarClass ──────────────────────────────

describe('severityClass', () => {
  it('maps buckets to Tailwind text colours', () => {
    strictEqual(severityClass('ok'), 'text-pnl-win');
    strictEqual(severityClass('caution'), 'text-amber-300');
    strictEqual(severityClass('warn'), 'text-orange-400');
    strictEqual(severityClass('critical'), 'text-pnl-loss');
    strictEqual(severityClass('unknown'), 'text-ash-300');
  });
});

describe('severityBarClass', () => {
  it('maps buckets to Tailwind bg colours', () => {
    strictEqual(severityBarClass('ok'), 'bg-pnl-win');
    strictEqual(severityBarClass('caution'), 'bg-amber-400');
    strictEqual(severityBarClass('warn'), 'bg-orange-500');
    strictEqual(severityBarClass('critical'), 'bg-pnl-loss');
    strictEqual(severityBarClass('unknown'), 'bg-ash-500');
  });
});

// ─── severityBarPct ────────────────────────────────────────────────

describe('severityBarPct', () => {
  it('clamps to [0,100]', () => {
    strictEqual(severityBarPct(null), 0);
    strictEqual(severityBarPct(undefined), 0);
    strictEqual(severityBarPct(NaN), 0);
    strictEqual(severityBarPct('50'), 0);
    strictEqual(severityBarPct(-1), 0);
    strictEqual(severityBarPct(0), 0);
    strictEqual(severityBarPct(50), 50);
    strictEqual(severityBarPct(100), 100);
    strictEqual(severityBarPct(150), 100);
  });
});

// ─── formatBchAmount ───────────────────────────────────────────────

describe('formatBchAmount', () => {
  it('returns — for null/NaN/non-finite', () => {
    strictEqual(formatBchAmount(null), '—');
    strictEqual(formatBchAmount(undefined), '—');
    strictEqual(formatBchAmount(NaN), '—');
    strictEqual(formatBchAmount('foo'), '—');
  });
  it('formats to 8 dp', () => {
    strictEqual(formatBchAmount(0), '0.00000000 BCH');
    strictEqual(formatBchAmount(0.005), '0.00500000 BCH');
    strictEqual(formatBchAmount(0.0000001), '0.00000010 BCH');
    strictEqual(formatBchAmount(1.23456789), '1.23456789 BCH');
  });
});

// ─── formatSatsAmount ──────────────────────────────────────────────

describe('formatSatsAmount', () => {
  it('returns — for null/invalid', () => {
    strictEqual(formatSatsAmount(null), '—');
    strictEqual(formatSatsAmount(undefined), '—');
    strictEqual(formatSatsAmount('not-num'), '—');
  });
  it('formats bigint as "N NNN NNN sat (X.XXXXXXXX BCH)"', () => {
    strictEqual(formatSatsAmount(500000n), '500 000 sat (0.00500000 BCH)');
    strictEqual(formatSatsAmount(1500000n), '1 500 000 sat (0.01500000 BCH)');
  });
  it('formats number + string', () => {
    strictEqual(formatSatsAmount(500000), '500 000 sat (0.00500000 BCH)');
    strictEqual(formatSatsAmount('500000'), '500 000 sat (0.00500000 BCH)');
  });
});

// ─── formatPctSigned ───────────────────────────────────────────────

describe('formatPctSigned', () => {
  it('returns — for null/invalid', () => {
    strictEqual(formatPctSigned(null), '—');
    strictEqual(formatPctSigned(NaN), '—');
  });
  it('formats with explicit + / - / blank sign', () => {
    strictEqual(formatPctSigned(0), '0.00%');
    strictEqual(formatPctSigned(0.5), '+0.50%');
    strictEqual(formatPctSigned(-3.456), '-3.46%');
    strictEqual(formatPctSigned(100), '+100.00%');
  });
});

// ─── utilizationPct ────────────────────────────────────────────────

describe('utilizationPct', () => {
  it('returns — for null/invalid', () => {
    strictEqual(utilizationPct(null), '—');
    strictEqual(utilizationPct(NaN), '—');
  });
  it('formats 0..1 as percentage with 1 dp', () => {
    strictEqual(utilizationPct(0), '0.0%');
    strictEqual(utilizationPct(0.25), '25.0%');
    strictEqual(utilizationPct(0.625), '62.5%');
    strictEqual(utilizationPct(1.0), '100.0%');
  });
});

// ─── relativeTimeAgo ───────────────────────────────────────────────

describe('relativeTimeAgo', () => {
  const now = Date.parse('2026-09-15T12:00:00Z');
  it('returns null for null/invalid input', () => {
    strictEqual(relativeTimeAgo(null, now), null);
    strictEqual(relativeTimeAgo('', now), null);
    strictEqual(relativeTimeAgo('not-a-date', now), null);
  });
  it('returns just-now for sub-minute elapsed', () => {
    strictEqual(relativeTimeAgo('2026-09-15T12:00:00Z', now), 'just now');
    strictEqual(relativeTimeAgo('2026-09-15T11:59:30Z', now), 'just now');
  });
  it('returns minutes for sub-hour elapsed', () => {
    strictEqual(relativeTimeAgo('2026-09-15T11:55:00Z', now), '5m ago');
    strictEqual(relativeTimeAgo('2026-09-15T11:30:00Z', now), '30m ago');
  });
  it('returns hours for sub-day elapsed', () => {
    strictEqual(relativeTimeAgo('2026-09-15T09:00:00Z', now), '3h ago');
    strictEqual(relativeTimeAgo('2026-09-14T13:00:00Z', now), '23h ago');
  });
  it('returns days for >= 1 day elapsed', () => {
    strictEqual(relativeTimeAgo('2026-09-14T12:00:00Z', now), '1d ago');
    strictEqual(relativeTimeAgo('2026-09-12T12:00:00Z', now), '3d ago');
  });
  it('returns just-now for future timestamps', () => {
    strictEqual(relativeTimeAgo('2026-09-15T13:00:00Z', now), 'just now');
  });
});

// ─── circuitBreakerSummary ─────────────────────────────────────────

describe('circuitBreakerSummary', () => {
  it('returns null for null/invalid', () => {
    strictEqual(circuitBreakerSummary(null), null);
    strictEqual(circuitBreakerSummary({}), null);
  });
  it('returns idle for non-tripped state', () => {
    deepStrictEqual(circuitBreakerSummary({ isTripped: false }), { status: 'idle', kind: null, reason: null });
  });
  it('returns tripped with daily_loss reason', () => {
    const out = circuitBreakerSummary({ isTripped: true, tripKind: 'daily_loss', recentDailyPnlSats: -800000n });
    strictEqual(out.status, 'tripped');
    strictEqual(out.kind, 'daily_loss');
    ok(out.reason.includes('-800000'));
  });
  it('returns tripped with consecutive_losses reason', () => {
    const out = circuitBreakerSummary({ isTripped: true, tripKind: 'consecutive_losses', consecutiveLosses: 3 });
    strictEqual(out.status, 'tripped');
    ok(out.reason.includes('3 stop-losses'));
  });
  it('returns tripped with loss_cooldown reason', () => {
    const out = circuitBreakerSummary({ isTripped: true, tripKind: 'loss_cooldown' });
    strictEqual(out.kind, 'loss_cooldown');
    ok(out.reason.includes('cooldown'));
  });
  it('returns unknown reason for unrecognized tripKind', () => {
    const out = circuitBreakerSummary({ isTripped: true, tripKind: 'manual' });
    ok(out.reason.includes('manual'));
  });
});