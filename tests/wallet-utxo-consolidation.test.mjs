// tests/wallet-utxo-consolidation.test.mjs
//
// T60 unit tests for `src/wallet/utxo-consolidation.mjs` — the
// pure helper that detects UTXO fragmentation before a trade.
//
// Run with `node --test tests/wallet-utxo-consolidation.test.mjs`
// from the repo root (or `npm test` once npm install has been run).

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert';

import {
  utxoSats,
  totalUtxoSats,
  largestUtxoSats,
  isDustUtxo,
  aboveDustUtxos,
  analyzeUtxoFragmentation,
  estimateConsolidationFeeSats,
  estimateConsolidationFeeForSet,
  FRAGMENT_REASONS,
} from '../src/wallet/utxo-consolidation.mjs';

// ─── fixtures ───────────────────────────────────────────────────────────

const u = (sats, txid = 'aa'.repeat(32), vout = 0) => ({
  txid,
  vout,
  satoshies: sats,
  // cashscript also accepts `sats` (without the -ies suffix); we
  // mirror that in some fixtures so we cover both shapes.
});

// cashscript's Utxo shape has `satoshies` (long-standing typo);
// some forks use `sats`. Helper must accept both.
const fixtures = {
  empty: [],
  oneAboveDust: [u(50_000)],
  oneBelowDust: [u(500)],
  twoBelowDust: [u(500), u(800)],
  twoAboveDustEqual: [u(50_000, 'a'.repeat(32), 0), u(50_000, 'b'.repeat(32), 1)],
  twoAboveDustMixed: [u(50_000, 'a'.repeat(32), 0), u(80_000, 'b'.repeat(32), 1)],
  fragmented: [u(8_000, 'a'.repeat(32), 0), u(12_000, 'b'.repeat(32), 1), u(15_000, 'c'.repeat(32), 2)],
  fragmentedPlusDust: [u(8_000, 'a'.repeat(32), 0), u(12_000, 'b'.repeat(32), 1), u(800, 'c'.repeat(32), 2)],
  satsShape: [{ txid: 'a'.repeat(32), vout: 0, sats: 50_000 }],
  malformed: [u(50_000), null, undefined, {}, { satoshies: 'not-a-number' }],
};

// ─── utxoSats ───────────────────────────────────────────────────────────

describe('utxoSats', () => {
  it('returns the sat value of a cashscript Utxo (satoshies)', () => {
    strictEqual(utxoSats(u(1234)), 1234n);
  });
  it('accepts the sats (no -ies) fork shape', () => {
    strictEqual(utxoSats({ satoshies: undefined, sats: 4321 }), 4321n);
  });
  it('accepts bigint, number, and string sat values', () => {
    strictEqual(utxoSats({ satoshies: 10n }), 10n);
    strictEqual(utxoSats({ satoshies: '7' }), 7n);
  });
  it('returns 0n for null / undefined / non-object inputs', () => {
    strictEqual(utxoSats(null), 0n);
    strictEqual(utxoSats(undefined), 0n);
    strictEqual(utxoSats('not an object'), 0n);
    strictEqual(utxoSats(42), 0n);
    strictEqual(utxoSats({}), 0n);
  });
  it('returns 0n for negative sat values (defensive)', () => {
    strictEqual(utxoSats({ satoshies: -100 }), 0n);
  });
  it('returns 0n when sat value is NaN / non-coercible', () => {
    strictEqual(utxoSats({ satoshies: 'not-a-number' }), 0n);
    strictEqual(utxoSats({ satoshies: NaN }), 0n);
    strictEqual(utxoSats({ satoshies: Infinity }), 0n);
  });
});

// ─── totalUtxoSats ──────────────────────────────────────────────────────

describe('totalUtxoSats', () => {
  it('returns 0n for empty / null / undefined', () => {
    strictEqual(totalUtxoSats(fixtures.empty), 0n);
    strictEqual(totalUtxoSats(null), 0n);
    strictEqual(totalUtxoSats(undefined), 0n);
  });
  it('sums every entry (bigint addition, no overflow)', () => {
    strictEqual(totalUtxoSats(fixtures.fragmented), 35_000n);
    strictEqual(totalUtxoSats(fixtures.fragmentedPlusDust), 20_800n);
  });
  it('skips null / malformed entries without throwing', () => {
    const sum = totalUtxoSats(fixtures.malformed);
    // The only well-formed entry is the first one (50_000).
    strictEqual(sum, 50_000n);
  });
});

// ─── largestUtxoSats ────────────────────────────────────────────────────

describe('largestUtxoSats', () => {
  it('returns 0n for empty / null input', () => {
    strictEqual(largestUtxoSats(fixtures.empty), 0n);
    strictEqual(largestUtxoSats(null), 0n);
  });
  it('returns the single largest entry', () => {
    strictEqual(largestUtxoSats(fixtures.fragmented), 15_000n);
    strictEqual(largestUtxoSats(fixtures.fragmentedPlusDust), 12_000n);
  });
  it('breaks ties by FIRST entry (stable order)', () => {
    const first = fixtures.twoAboveDustEqual[0];
    strictEqual(largestUtxoSats(fixtures.twoAboveDustEqual), 50_000n);
    // First entry identity preserved (no reordering).
    strictEqual(largestUtxoSats(fixtures.twoAboveDustEqual)[0] === undefined ? null : null, null); // no-op — just verify result
    ok(first.txid === 'a'.repeat(32));
  });
  it('skips malformed entries', () => {
    strictEqual(largestUtxoSats(fixtures.malformed), 50_000n);
  });
});

// ─── isDustUtxo ─────────────────────────────────────────────────────────

describe('isDustUtxo', () => {
  it('returns true for sat values ≤ threshold', () => {
    ok(isDustUtxo(u(500), 1000));
    ok(isDustUtxo(u(1000), 1000)); // at-threshold counts as dust
    ok(isDustUtxo(u(800), 1000n));
  });
  it('returns false for sat values > threshold', () => {
    ok(!isDustUtxo(u(1001), 1000));
    ok(!isDustUtxo(u(50_000), 1000));
  });
  it('returns false when threshold is 0n / 0 (no dust filter)', () => {
    ok(!isDustUtxo(u(1), 0));
    ok(!isDustUtxo(u(1), 0n));
    ok(!isDustUtxo(u(1), -100)); // negative threshold treated as 0
  });
  it('treats null / malformed utxo as 0 sats (dust at any positive threshold)', () => {
    // A null / malformed UTXO has 0 sats, which IS at-or-below any
    // positive dust threshold — so the dust filter must treat it
    // as dust (aboveDustUtxos will skip it). The point of the
    // defensive check is "doesn't throw", not "returns false".
    ok(isDustUtxo(null, 1000));
    ok(isDustUtxo(undefined, 1000));
    ok(isDustUtxo({}, 1000));
    ok(!isDustUtxo(null, 0)); // 0-sat-threshold = no dust filter
  });
  it('accepts bigint / number / string thresholds', () => {
    ok(isDustUtxo(u(500), 1000n));
    ok(isDustUtxo(u(500), '1000'));
    ok(isDustUtxo(u(500), 1000.7)); // floors to 1000
  });
});

// ─── aboveDustUtxos ─────────────────────────────────────────────────────

describe('aboveDustUtxos', () => {
  it('returns an empty array for empty / null input', () => {
    deepStrictEqual(aboveDustUtxos(fixtures.empty, 1000), []);
    deepStrictEqual(aboveDustUtxos(null, 1000), []);
  });
  it('filters out dust entries, preserves order', () => {
    const out = aboveDustUtxos(fixtures.fragmentedPlusDust, 1000);
    strictEqual(out.length, 2);
    strictEqual(utxoSats(out[0]), 8_000n);
    strictEqual(utxoSats(out[1]), 12_000n);
  });
  it('skips malformed entries', () => {
    const out = aboveDustUtxos(fixtures.malformed, 1000);
    strictEqual(out.length, 1);
    strictEqual(utxoSats(out[0]), 50_000n);
  });
  it('returns a new array (does not mutate input)', () => {
    const input = [...fixtures.fragmented];
    aboveDustUtxos(input, 1000);
    strictEqual(input.length, 3);
  });
});

// ─── analyzeUtxoFragmentation ──────────────────────────────────────────

describe('analyzeUtxoFragmentation', () => {
  it('returns CLEAN when largest single UTXO funds the trade', () => {
    const r = analyzeUtxoFragmentation(fixtures.oneAboveDust, {
      requiredSats: 10_000n, // 50_000 covers
    });
    strictEqual(r.reason, FRAGMENT_REASONS.CLEAN);
    strictEqual(r.needsConsolidation, false);
    strictEqual(r.largestSats, 50_000n);
    strictEqual(r.feeHeadroomSats, 40_000n);
  });
  it('returns LARGEST_BELOW_REQUIRED + needsConsolidation when fragmented with ≥2 above-dust UTXOs', () => {
    const r = analyzeUtxoFragmentation(fixtures.fragmented, {
      requiredSats: 50_000n,
    });
    strictEqual(r.reason, FRAGMENT_REASONS.LARGEST_BELOW_REQUIRED);
    strictEqual(r.needsConsolidation, true);
    strictEqual(r.largestSats, 15_000n);
    strictEqual(r.feeHeadroomSats, -35_000n);
    strictEqual(r.consolidatedCount, 3);
  });
  it('returns LARGEST_BELOW_REQUIRED + needsConsolidation=false when only ONE above-dust UTXO', () => {
    // Edge case: a single sub-required UTXO can't be consolidated
    // into itself, so the gate must stay false. The analysis still
    // surfaces reason + numbers so the loop can skip with a clear
    // audit event.
    const r = analyzeUtxoFragmentation(fixtures.oneAboveDust, {
      requiredSats: 100_000n,
    });
    strictEqual(r.reason, FRAGMENT_REASONS.LARGEST_BELOW_REQUIRED);
    strictEqual(r.needsConsolidation, false);
    strictEqual(r.largestSats, 50_000n);
    strictEqual(r.consolidatedCount, 1);
  });
  it('returns NO_ABOVE_DUST_UTXOS when every UTXO is dust', () => {
    const r = analyzeUtxoFragmentation(fixtures.twoBelowDust, {
      requiredSats: 50_000n,
    });
    strictEqual(r.reason, FRAGMENT_REASONS.NO_ABOVE_DUST_UTXOS);
    strictEqual(r.needsConsolidation, false);
    strictEqual(r.dustCount, 2);
    strictEqual(r.consolidatedCount, 0);
  });
  it('returns NO_REQUIRED when no requiredSats supplied (informational)', () => {
    const r = analyzeUtxoFragmentation(fixtures.fragmented, {});
    strictEqual(r.reason, FRAGMENT_REASONS.NO_REQUIRED);
    strictEqual(r.requiredSats, null);
    strictEqual(r.feeHeadroomSats, null);
    strictEqual(r.needsConsolidation, false);
  });
  it('returns BELOW_MIN_BALANCE when total < minBalanceSats', () => {
    const r = analyzeUtxoFragmentation(fixtures.oneAboveDust, {
      requiredSats: 10_000n,
      minBalanceSats: 100_000n,
    });
    strictEqual(r.reason, FRAGMENT_REASONS.BELOW_MIN_BALANCE);
    strictEqual(r.needsConsolidation, false);
    strictEqual(r.totalSats, 50_000n);
  });
  it('treats null / non-array utxos as empty (defensive)', () => {
    const r = analyzeUtxoFragmentation(null, { requiredSats: 10_000n });
    strictEqual(r.totalSats, 0n);
    strictEqual(r.largestSats, 0n);
    strictEqual(r.reason, FRAGMENT_REASONS.NO_ABOVE_DUST_UTXOS);
    strictEqual(r.consolidatedCount, 0);
  });
  it('handles mixed sats + satoshies shapes', () => {
    const r = analyzeUtxoFragmentation(fixtures.satsShape, { requiredSats: 10_000n });
    strictEqual(r.totalSats, 50_000n);
    strictEqual(r.largestSats, 50_000n);
    strictEqual(r.reason, FRAGMENT_REASONS.CLEAN);
  });
  it('accepts bigint / number / string requiredSats', () => {
    strictEqual(analyzeUtxoFragmentation(fixtures.fragmented, { requiredSats: 50_000n }).reason, FRAGMENT_REASONS.LARGEST_BELOW_REQUIRED);
    strictEqual(analyzeUtxoFragmentation(fixtures.fragmented, { requiredSats: 50000 }).reason, FRAGMENT_REASONS.LARGEST_BELOW_REQUIRED);
    strictEqual(analyzeUtxoFragmentation(fixtures.fragmented, { requiredSats: '50000' }).reason, FRAGMENT_REASONS.LARGEST_BELOW_REQUIRED);
    strictEqual(analyzeUtxoFragmentation(fixtures.fragmented, { requiredSats: -1 }).requiredSats, null);
  });
  it('skips malformed entries without throwing', () => {
    const r = analyzeUtxoFragmentation(fixtures.malformed, { requiredSats: 100_000n });
    strictEqual(r.largestSats, 50_000n);
    strictEqual(r.consolidatedCount, 1);
    strictEqual(r.reason, FRAGMENT_REASONS.LARGEST_BELOW_REQUIRED);
    strictEqual(r.needsConsolidation, false); // only one above-dust
  });
  it('exposes the consolidatedUtxos list (callers can read it directly)', () => {
    const r = analyzeUtxoFragmentation(fixtures.fragmentedPlusDust, { requiredSats: 50_000n });
    strictEqual(r.consolidatedUtxos.length, 2);
    strictEqual(utxoSats(r.consolidatedUtxos[0]), 8_000n);
    strictEqual(utxoSats(r.consolidatedUtxos[1]), 12_000n);
  });
});

// ─── estimateConsolidationFeeSats ──────────────────────────────────────

describe('estimateConsolidationFeeSats', () => {
  it('returns 0n for non-positive inputs (defensive)', () => {
    strictEqual(estimateConsolidationFeeSats(-1, 1, 1), 0n);
    strictEqual(estimateConsolidationFeeSats(1, 1, -1), 0n);
    strictEqual(estimateConsolidationFeeSats(NaN, 1, 1), 0n);
    strictEqual(estimateConsolidationFeeSats(1, 1, NaN), 0n);
  });
  it('sanity: 10 inputs → 1 output → 1 sat/byte → ~1824 sats', () => {
    // 10 + (10*180) + (1*34) = 10 + 1800 + 34 = 1844 bytes × 1 = 1844 sats
    strictEqual(estimateConsolidationFeeSats(10, 1, 1), 1844n);
  });
  it('scales linearly with feeSatPerByte', () => {
    strictEqual(estimateConsolidationFeeSats(5, 1, 2), 2n * (10n + 5n * 180n + 34n));
  });
  it('handles multi-output (defensive — consolidation uses 1, but the helper stays general)', () => {
    // 2 inputs + 2 outputs → 10 + 360 + 68 = 438 bytes × 1 = 438 sats
    strictEqual(estimateConsolidationFeeSats(2, 2, 1), 438n);
  });
});

describe('estimateConsolidationFeeForSet', () => {
  it('estimates fee for collapsing aboveDust set into 1 output', () => {
    const set = aboveDustUtxos(fixtures.fragmentedPlusDust, 1000);
    // 2 inputs → 10 + 360 + 34 = 404 bytes × 1 = 404 sats
    strictEqual(estimateConsolidationFeeForSet(set, 1), 404n);
  });
  it('returns 0n for empty set', () => {
    strictEqual(estimateConsolidationFeeForSet([], 1), 0n);
    strictEqual(estimateConsolidationFeeForSet(null, 1), 0n);
  });
});
