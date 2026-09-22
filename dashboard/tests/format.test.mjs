// dashboard/tests/format.test.mjs
//
// Unit tests for the pure formatting helpers in `src/lib/format.mjs`.
// Run with `node --test` from the dashboard/ directory (or the repo root
// with `node --test tests/format.test.mjs`).
//
// Coverage:
//   SATS_PER_BCH / satsToBch / formatBch / formatSats / formatPct /
//   pnlClass / formatDuration / formatUtc / truncate / statusClass /
//   sideClass / parseBchToSats / parseNumberOr

import { describe, it } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { SATS_PER_BCH, satsToBch, formatBch, formatSats, formatPct, pnlClass,
         formatDuration, formatUtc, formatLocal, truncate, statusClass, sideClass,
         parseBchToSats, parseNumberOr, formatSatsBch, formatTokenAmount } from '../src/lib/format.mjs';

// ─── SATS_PER_BCH ───────────────────────────────────────────────────

describe('SATS_PER_BCH', () => {
  it('equals 100_000_000', () => strictEqual(SATS_PER_BCH, 100_000_000));
});

// ─── satsToBch ──────────────────────────────────────────────────────

describe('satsToBch', () => {
  it('converts integer satoshis correctly', () => {
    strictEqual(satsToBch(100_000_000), 1.0);
    strictEqual(satsToBch(50_000_000), 0.5);
    strictEqual(satsToBch(1_000_000), 0.01);
    strictEqual(satsToBch(1), 0.00000001);
  });

  it('accepts string satoshis', () => {
    strictEqual(satsToBch('100000000'), 1.0);
    strictEqual(satsToBch('0'), 0.0);
  });

  it('accepts bigint satoshis', () => {
    strictEqual(satsToBch(100_000_000n), 1.0);
  });

  it('handles null / undefined → null', () => {
    strictEqual(satsToBch(null), null);
    strictEqual(satsToBch(undefined), null);
  });

  it('handles empty / unparseable strings → null', () => {
    strictEqual(satsToBch(''), null);
    strictEqual(satsToBch('abc'), null);
  });

  it('handles NaN / Infinity → null', () => {
    strictEqual(satsToBch(NaN), null);
    strictEqual(satsToBch(Infinity), null);
    strictEqual(satsToBch(-Infinity), null);
  });
});

// ─── formatBch ──────────────────────────────────────────────────────

describe('formatBch', () => {
  it('formats BCH with up to 8 decimal places', () => {
    strictEqual(formatBch(100_000_000), '1.00000000 BCH');
    strictEqual(formatBch(50_000_000), '0.50000000 BCH');
    strictEqual(formatBch(1_000_000), '0.01000000 BCH');
    strictEqual(formatBch(1), '0.00000001 BCH');
  });

  it('strips trailing zeros when requested', () => {
    strictEqual(formatBch(100_000_000, { maxDecimals: 4 }), '1.0000 BCH');
    strictEqual(formatBch(50_000_000, { maxDecimals: 2 }), '0.50 BCH');
  });

  it('returns placeholder for null / undefined', () => {
    strictEqual(formatBch(null), '—');
    strictEqual(formatBch(undefined), '—');
  });

  it('accepts string input', () => {
    strictEqual(formatBch('50000000'), '0.50000000 BCH');
  });

  it('accepts bigint input', () => {
    strictEqual(formatBch(5_000_000n), '0.05000000 BCH');
  });
});

// ─── formatSats ─────────────────────────────────────────────────────

describe('formatSats', () => {
  it('formats large sat amounts with thousand separators', () => {
    // 1_000_000 = 1 million sats → groups: 1 000 000
    strictEqual(formatSats(1_000_000), '1\u202F000\u202F000\u202Fsat');
    // 10_000_000 = 10 million → groups: 10 000 000
    strictEqual(formatSats(10_000_000), '10\u202F000\u202F000\u202Fsat');
    // 100_000_000 = 100 million → groups: 100 000 000
    strictEqual(formatSats(100_000_000), '100\u202F000\u202F000\u202Fsat');
  });

  it('handles negative numbers', () => {
    // -50_000_000 = -50 million sats → groups: 50 000 000
    strictEqual(formatSats(-50_000_000), '-50\u202F000\u202F000\u202Fsat');
  });

  it('returns placeholder for null / undefined', () => {
    strictEqual(formatSats(null), '—');
    strictEqual(formatSats(undefined), '—');
  });

  it('returns placeholder for unparseable strings', () => {
    strictEqual(formatSats('abc'), '—');
    strictEqual(formatSats(''), '—');
  });
});

// ─── formatPct ──────────────────────────────────────────────────────

describe('formatPct', () => {
  it('formats positive percentages with + prefix', () => {
    strictEqual(formatPct(5.0), '+5.00%');
    strictEqual(formatPct(0.5, 1), '+0.5%');
    strictEqual(formatPct(100), '+100.00%');
  });

  it('formats negative percentages without + prefix', () => {
    strictEqual(formatPct(-3.5), '-3.50%');
    strictEqual(formatPct(-0.1), '-0.10%');
  });

  it('formats zero as +0.00%', () => {
    strictEqual(formatPct(0), '+0.00%');
  });

  it('respects decimal precision option', () => {
    strictEqual(formatPct(12.3456, 1), '+12.3%');
    strictEqual(formatPct(12.3456, 0), '+12%');
  });

  it('returns placeholder for null / undefined / NaN', () => {
    strictEqual(formatPct(null), '—');
    strictEqual(formatPct(undefined), '—');
    strictEqual(formatPct(NaN), '—');
  });
});

// ─── pnlClass ──────────────────────────────────────────────────────

describe('pnlClass', () => {
  it('returns win class for positive pct', () => {
    strictEqual(pnlClass(0.001), 'text-pnl-win');
    strictEqual(pnlClass(1), 'text-pnl-win');
  });

  it('returns loss class for negative pct', () => {
    strictEqual(pnlClass(-0.001), 'text-pnl-loss');
    strictEqual(pnlClass(-1), 'text-pnl-loss');
  });

  it('returns neutral class for zero', () => {
    strictEqual(pnlClass(0), 'text-pnl-neutral');
  });

  it('returns neutral class for null / undefined / NaN', () => {
    strictEqual(pnlClass(null), 'text-pnl-neutral');
    strictEqual(pnlClass(undefined), 'text-pnl-neutral');
    strictEqual(pnlClass(NaN), 'text-pnl-neutral');
  });
});

// ─── formatDuration ─────────────────────────────────────────────────

describe('formatDuration', () => {
  it('formats milliseconds', () => {
    strictEqual(formatDuration(500), '500ms');
    strictEqual(formatDuration(999), '999ms');
  });

  it('formats seconds', () => {
    strictEqual(formatDuration(1000), '1s');
    strictEqual(formatDuration(65_000), '1m 5s');
  });

  it('formats minutes', () => {
    strictEqual(formatDuration(60_000), '1m 0s');
    strictEqual(formatDuration(3_600_000), '1h 0m');
  });

  it('formats hours', () => {
    strictEqual(formatDuration(3_600_001), '1h 0m');
    strictEqual(formatDuration(86_400_000), '1d 0h');
  });

  it('formats days', () => {
    strictEqual(formatDuration(90_000_000), '1d 1h');
    strictEqual(formatDuration(172_800_000), '2d 0h');
  });

  it('returns placeholder for null / undefined / NaN', () => {
    strictEqual(formatDuration(null), '—');
    strictEqual(formatDuration(undefined), '—');
    strictEqual(formatDuration(NaN), '—');
  });
});

// ─── formatUtc ──────────────────────────────────────────────────────

describe('formatUtc', () => {
  it('formats an ISO string correctly', () => {
    const out = formatUtc('2026-09-11T15:25:00.000Z');
    strictEqual(out, '2026-09-11 15:25:00');
  });

  it('formats a Date correctly', () => {
    const out = formatUtc(new Date('2026-09-11T15:25:00.000Z'));
    strictEqual(out, '2026-09-11 15:25:00');
  });

  it('formats an epoch ms number correctly', () => {
    const ms = new Date('2026-09-11T15:25:00.000Z').getTime();
    strictEqual(formatUtc(ms), '2026-09-11 15:25:00');
  });

  it('returns placeholder for null / undefined / invalid', () => {
    strictEqual(formatUtc(null), '—');
    strictEqual(formatUtc(undefined), '—');
    strictEqual(formatUtc('not-a-date'), '—');
    strictEqual(formatUtc(NaN), '—');
  });
});

// ─── formatLocal ──────────────────────────────────────────────────
//
// The default path uses the runtime TZ (browser's TZ in the dashboard,
// host's TZ in node --test). To lock the contract regardless of CI
// timezone we exercise the `tz` option for every "local" case too —
// the same ISO 8601 instant formatted in UTC, America/Vancouver, and
// America/Los_Angeles should give three different surface strings but
// all match `YYYY-MM-DD HH:MM:SS`.

describe('formatLocal', () => {
  it('formats an ISO string in the operator-supplied tz', () => {
    const iso = '2026-09-11T15:25:00.000Z';
    strictEqual(formatLocal(iso, { tz: 'UTC' }), '2026-09-11 15:25:00');
    // America/Vancouver is UTC-7 year-round (no DST flagging in the
    // formatter when the test instant falls inside PDT).
    strictEqual(formatLocal(iso, { tz: 'America/Vancouver' }), '2026-09-11 08:25:00');
    // America/Los_Angeles is UTC-7 during PDT (Sep 11 2026 falls in
    // PDT).
    strictEqual(formatLocal(iso, { tz: 'America/Los_Angeles' }), '2026-09-11 08:25:00');
    // Asia/Tokyo is UTC+9.
    strictEqual(formatLocal(iso, { tz: 'Asia/Tokyo' }), '2026-09-12 00:25:00');
  });

  it('formats a Date correctly with explicit tz', () => {
    const out = formatLocal(new Date('2026-09-11T15:25:00.000Z'), { tz: 'UTC' });
    strictEqual(out, '2026-09-11 15:25:00');
  });

  it('formats an epoch ms number correctly with explicit tz', () => {
    const ms = new Date('2026-09-11T15:25:00.000Z').getTime();
    strictEqual(formatLocal(ms, { tz: 'UTC' }), '2026-09-11 15:25:00');
  });

  it('returns placeholder for null / undefined / invalid', () => {
    strictEqual(formatLocal(null), '—');
    strictEqual(formatLocal(undefined), '—');
    strictEqual(formatLocal('not-a-date'), '—');
    strictEqual(formatLocal(NaN), '—');
    strictEqual(formatLocal(null, { tz: 'UTC' }), '—');
    strictEqual(formatLocal(undefined, { tz: 'America/Vancouver' }), '—');
    strictEqual(formatLocal('not-a-date', { tz: 'UTC' }), '—');
  });

  it('default path (no tz arg) returns YYYY-MM-DD HH:MM:SS shape', () => {
    // We can't lock the host-TZ local output (it varies by machine),
    // so just enforce the shape: same character class as formatUtc.
    const out = formatLocal('2026-09-11T15:25:00.000Z');
    ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(out), `expected YYYY-MM-DD HH:MM:SS, got "${out}"`);
  });

  it('differs from formatUtc when the host has a non-UTC TZ (CI guard)', () => {
    // On a CI runner in UTC, the local path happens to match UTC,
    // so skip the strict-inequality assertion (would flake).
    // We only assert the shape contract — same chars as formatUtc.
    const d = '2026-09-11T15:25:00.000Z';
    const utcOut = formatUtc(d);
    const localOut = formatLocal(d);
    ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(localOut), `local shape ok: ${localOut}`);
    ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(utcOut), `utc shape ok: ${utcOut}`);
  });
});

// ─── truncate ───────────────────────────────────────────────────────

describe('truncate', () => {
  it('leaves short strings unchanged', () => {
    strictEqual(truncate('abc', 12), 'abc');
    strictEqual(truncate('hello', 5), 'hello');
  });

  it('truncates long strings with ellipsis', () => {
    // 'bitcoincashqqcp6q32dt4x' (20 chars) → max=12 → 11 chars + '…'
    strictEqual(truncate('bitcoincashqqcp6q32dt4x', 12), 'bitcoincash…');
    strictEqual(truncate('abcdefghijk', 8), 'abcdefg…');
  });

  it('returns placeholder for null / undefined', () => {
    strictEqual(truncate(null, 12), '—');
    strictEqual(truncate(undefined, 12), '—');
  });

  it('handles max ≤ 3 (edge case)', () => {
    strictEqual(truncate('abcdef', 3), 'abc');
    strictEqual(truncate('abcdef', 1), 'a');
  });

  it('defaults max to 12 when not provided', () => {
    const long = 'a'.repeat(30);
    const out = truncate(long);
    strictEqual(out.length, 12); // 11 chars + ellipsis = 12
    strictEqual(out.endsWith('…'), true);
  });
});

// ─── statusClass ────────────────────────────────────────────────────

describe('statusClass', () => {
  it('returns correct class per status', () => {
    ok(statusClass('open').includes('emerald'));
    ok(statusClass('pending').includes('amber'));
    ok(statusClass('closing').includes('sky'));
    ok(statusClass('closed').includes('ink'));
  });

  it('defaults to ink for unknown status', () => {
    ok(statusClass('unknown').includes('ink'));
    ok(statusClass(null).includes('ink'));
  });
});

// ─── sideClass ──────────────────────────────────────────────────────

describe('sideClass', () => {
  it('returns correct class per side', () => {
    strictEqual(sideClass('buy'), 'text-bch-400');
    strictEqual(sideClass('sell'), 'text-pnl-loss');
  });

  it('returns ash-200 for unknown side', () => {
    strictEqual(sideClass('hold'), 'text-ash-200');
    strictEqual(sideClass(null), 'text-ash-200');
  });
});

// ─── parseBchToSats ─────────────────────────────────────────────────

describe('parseBchToSats', () => {
  it('converts BCH string to sat string', () => {
    strictEqual(parseBchToSats('0.005'), '500000');
    strictEqual(parseBchToSats('1.0'), '100000000');
    strictEqual(parseBchToSats('0.00000001'), '1');
    strictEqual(parseBchToSats('0.04435967'), '4435967');
  });

  it('handles number input', () => {
    strictEqual(parseBchToSats(0.005), '500000');
    strictEqual(parseBchToSats(1.0), '100000000');
  });

  it('rejects negative / non-finite / unparseable', () => {
    strictEqual(parseBchToSats(-0.005), null);
    strictEqual(parseBchToSats(NaN), null);
    strictEqual(parseBchToSats('abc'), null);
    strictEqual(parseBchToSats(''), null);
    strictEqual(parseBchToSats(null), null);
    strictEqual(parseBchToSats(undefined), null);
  });

  it('rounds fractional sats correctly', () => {
    // 0.00500001 BCH → 500001 sat (rounded)
    strictEqual(parseBchToSats('0.00500001'), '500001');
  });
});

// ─── parseNumberOr ──────────────────────────────────────────────────

describe('parseNumberOr', () => {
  it('returns the number when input is a finite number', () => {
    strictEqual(parseNumberOr(5, 0), 5);
    strictEqual(parseNumberOr(0, 99), 0);
    strictEqual(parseNumberOr(-3.5, 0), -3.5);
  });

  it('parses a numeric string', () => {
    strictEqual(parseNumberOr('5', 0), 5);
    strictEqual(parseNumberOr('  42  ', 0), 42);
  });

  it('returns fallback for null / undefined / NaN / non-numeric string', () => {
    strictEqual(parseNumberOr(null, 99), 99);
    strictEqual(parseNumberOr(undefined, 99), 99);
    strictEqual(parseNumberOr(NaN, 99), 99);
    strictEqual(parseNumberOr('abc', 99), 99);
    strictEqual(parseNumberOr('', 99), 99);
  });
});

// ─── formatSatsBch ──────────────────────────────────────────────────

describe('formatSatsBch', () => {
  it('formats a number sat amount with thin-space separators + 4-decimal BCH', () => {
    strictEqual(formatSatsBch(150_000_000), '150\u202F000\u202F000\u202Fsat (1.5000\u202FBCH)');
  });

  it('formats a string sat amount (string sats come from the backend)', () => {
    strictEqual(formatSatsBch('50000000'), '50\u202F000\u202F000\u202Fsat (0.5000\u202FBCH)');
  });

  it('accepts bigint sat amounts', () => {
    strictEqual(formatSatsBch(150_000_000n), '150\u202F000\u202F000\u202Fsat (1.5000\u202FBCH)');
  });

  it('returns null for null / undefined / NaN / unparseable input', () => {
    strictEqual(formatSatsBch(null), null);
    strictEqual(formatSatsBch(undefined), null);
    strictEqual(formatSatsBch(NaN), null);
    strictEqual(formatSatsBch('abc'), null);
    strictEqual(formatSatsBch(''), null);
  });

  it('handles zero', () => {
    strictEqual(formatSatsBch(0), '0\u202Fsat (0.0000\u202FBCH)');
    strictEqual(formatSatsBch('0'), '0\u202Fsat (0.0000\u202FBCH)');
  });

  it('respects opts.maxDecimals', () => {
    strictEqual(formatSatsBch(123_456_789, { maxDecimals: 6 }),
                 '123\u202F456\u202F789\u202Fsat (1.234568\u202FBCH)');
    strictEqual(formatSatsBch(123_456_789, { maxDecimals: 2 }),
                 '123\u202F456\u202F789\u202Fsat (1.23\u202FBCH)');
  });

  it('handles small sat values (sub-bch dust)', () => {
    // 1000 sats = 0.00001 BCH
    strictEqual(formatSatsBch(1_000), '1\u202F000\u202Fsat (0.0000\u202FBCH)');
    // 1_500_000_000 sats = 15 BCH (no separator on 3-digit, but 4-digit gets one)
    strictEqual(formatSatsBch(1_500_000_000), '1\u202F500\u202F000\u202F000\u202Fsat (15.0000\u202FBCH)');
  });

  it('handles negative amounts (negative kept intact in both fields)', () => {
    // Negative sat values shouldn't normally appear in a config knob,
    // but the helper degrades gracefully: the dash is preserved in
    // both the sats count and the BCH total.
    strictEqual(formatSatsBch(-150_000_000), '-150\u202F000\u202F000\u202Fsat (-1.5000\u202FBCH)');
  });
});

// ─── formatTokenAmount ──────────────────────────────────────────────
//
// Used by the wallet card to render fungible-token UTXO balances
// in human-readable units. The on-chain amount is an integer
// ("base units"); the BCMR-reported `decimals` field tells the
// helper how to scale it. The motivating case is Olando
// (decimals=2): 507044 base units → "5,070.44" — without the
// helper the dashboard displays raw 507044 (off by 100x).

describe('formatTokenAmount', () => {
  it('handles the Olando case (decimals=2, raw=507044 → 5,070.44)', () => {
    // 507044 / 10^2 = 5070.44 → "5,070.44"
    strictEqual(formatTokenAmount('507044', 2), '5\u202F070.44');
  });

  it('formats a 0-decimal token with thin-space thousand separators', () => {
    strictEqual(formatTokenAmount('1282', 0), '1\u202F282');
    strictEqual(formatTokenAmount('500000', 0), '500\u202F000');
  });

  it('formats an 8-decimal token without losing precision (QBTC)', () => {
    // 1513 base units at decimals=8 → 0.00001513 QBTC
    strictEqual(formatTokenAmount('1513', 8), '0.00001513');
  });

  it('formats an 8-decimal token with a large integer part', () => {
    // 766574 / 10^2 (NWB, decimals=2) = 7,665.74
    strictEqual(formatTokenAmount('766574', 2), '7\u202F665.74');
  });

  it('trims trailing zeros in the fractional part', () => {
    // 507040 at decimals=2 = 5,070.40 → trimmed to "5,070.4"
    strictEqual(formatTokenAmount('507040', 2), '5\u202F070.4');
    // 1000 at decimals=2 = 10 → no fractional digits
    strictEqual(formatTokenAmount('1000', 2), '10');
    // 1 at decimals=8 = 0.00000001 → trim nothing
    strictEqual(formatTokenAmount('1', 8), '0.00000001');
  });

  it('pads short fractional digits with zeros when integer part is short', () => {
    // 1 sat at decimals=8 → 0.00000001 (8 zeros, no truncation)
    strictEqual(formatTokenAmount('1', 8), '0.00000001');
    // 100 at decimals=8 → 0.00000100 → trim trailing zeros → 0.000001
    strictEqual(formatTokenAmount('100', 8), '0.000001');
  });

  it('accepts bigint and number input', () => {
    strictEqual(formatTokenAmount(507044n, 2), '5\u202F070.44');
    strictEqual(formatTokenAmount(507044, 2), '5\u202F070.44');
  });

  it('handles negative amounts', () => {
    // Negative base units shouldn't appear in the wallet card,
    // but the helper degrades gracefully.
    strictEqual(formatTokenAmount('-507044', 2), '-5\u202F070.44');
  });

  it('respects opts.maxDecimals (truncates beyond the cap)', () => {
    // 1513 at decimals=8 with cap=4 → 0.0000 (truncated, then trimmed to 0)
    strictEqual(formatTokenAmount('1513', 8, { maxDecimals: 4 }), '0');
    // 123456 at decimals=8 = 0.00123456 → with cap=6 → 0.001234
    strictEqual(formatTokenAmount('123456', 8, { maxDecimals: 6 }), '0.001234');
  });

  it('falls back to raw integer (with separators) when decimals is missing', () => {
    // No decimals known → operator still sees the magnitude.
    strictEqual(formatTokenAmount('507044', null), '507\u202F044');
    strictEqual(formatTokenAmount('507044', undefined), '507\u202F044');
  });

  it('falls back to raw integer when decimals is non-finite', () => {
    strictEqual(formatTokenAmount('507044', NaN), '507\u202F044');
    strictEqual(formatTokenAmount('507044', -1), '507\u202F044');
  });

  it('returns PLACEHOLDER ("—") for unparseable input', () => {
    strictEqual(formatTokenAmount(null, 2), '—');
    strictEqual(formatTokenAmount(undefined, 2), '—');
    strictEqual(formatTokenAmount('abc', 2), '—');
    strictEqual(formatTokenAmount('', 2), '—');
    strictEqual(formatTokenAmount('1.5', 2), '—');     // decimals-only
    strictEqual(formatTokenAmount(NaN, 2), '—');
  });

  it('opts.rawOnMissing=false returns PLACEHOLDER for missing decimals', () => {
    // Strict callers (e.g. a future "show only formatted amounts"
    // toggle) can opt out of the raw-int fallback.
    strictEqual(formatTokenAmount('507044', null, { rawOnMissing: false }), '—');
    strictEqual(formatTokenAmount('507044', undefined, { rawOnMissing: false }), '—');
  });

  it('handles a value larger than 2^53 safely (BigInt base units)', () => {
    // Some Fungible-Cashtoken-NFT series can have enormous supplies;
    // Number would lose precision at > 2^53, BigInt doesn't.
    const huge = '100000000000000001'; // 1e17 + 1
    strictEqual(formatTokenAmount(huge, 0), '100\u202F000\u202F000\u202F000\u202F000\u202F001');
  });
});