#!/usr/bin/env node
// dashboard/tests/reasoning-view.test.mjs
//
// T40: unit tests for the pure helpers exported from
// `src/views/reasoning-helpers.mjs`. Same shape as the
// proposals-helpers / api.test.mjs split: the .jsx holds the
// React component, the .mjs holds the Node-testable formatting
// + grouping helpers. We don't pull in jsdom for these tests.
//
// Coverage:
//   • groupReasoningEntries — section ordering, missing-key
//     tolerance, unknown-key fallback, deep-clone safety.
//   • hasReasoningDetails   — null / empty / unknown-key fallback.
//   • formatReasoningValue  — number / string / boolean / array /
//     object / null / undefined / non-finite.
//   • formatSatsValue       — bigint / string / number / null /
//     undefined / negative / unparseable.
//   • isSatsKey             — exact match + suffix match + known
//     special keys; case-sensitive.
//   • isSensitiveKey        — WIF / mnemonic / seed / private_key
//     case-insensitive matching; non-string returns false.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert';

import {
  groupReasoningEntries,
  hasReasoningDetails,
  formatReasoningValue,
  formatSatsValue,
  isSatsKey,
  isSensitiveKey,
} from '../src/views/reasoning-helpers.mjs';

// ─── groupReasoningEntries ─────────────────────────────────────────

describe('groupReasoningEntries', () => {
  it('returns [] for null', () => {
    deepStrictEqual(groupReasoningEntries(null), []);
  });
  it('returns [] for undefined', () => {
    deepStrictEqual(groupReasoningEntries(undefined), []);
  });
  it('returns [] for non-object', () => {
    deepStrictEqual(groupReasoningEntries('hello'), []);
    deepStrictEqual(groupReasoningEntries(42), []);
    deepStrictEqual(groupReasoningEntries([]), []);
  });
  it('places decision.* in the Why bucket', () => {
    const out = groupReasoningEntries({ decision: { kind: 'enter' } });
    strictEqual(out.length, 1);
    strictEqual(out[0].id, 'why');
    strictEqual(out[0].label, 'Why');
    deepStrictEqual(out[0].entries, [['decision', { kind: 'enter' }]]);
  });
  it('places conditions.* in the Conditions bucket', () => {
    const out = groupReasoningEntries({ conditions: { max_position_bch: 0.005 } });
    strictEqual(out.length, 1);
    strictEqual(out[0].id, 'conditions');
  });
  it('places scoring keys in the Scoring bucket', () => {
    const out = groupReasoningEntries({ score: 0.7, rank: 2, topK: 5 });
    strictEqual(out.length, 1);
    strictEqual(out[0].id, 'scoring');
    strictEqual(out[0].entries.length, 3);
  });
  it('places passed_filters + notes + breakdown in the Scoring bucket', () => {
    const out = groupReasoningEntries({
      passed_filters: ['volume_ok'],
      notes: ['seed detected'],
      breakdown: { raw: { tvl_bch: 1 } },
    });
    strictEqual(out.length, 1);
    strictEqual(out[0].id, 'scoring');
  });
  it('places ts / ts_iso / token_id / eligible_for_trade in Meta', () => {
    const out = groupReasoningEntries({
      ts: 1234,
      ts_iso: '2026-09-15T00:00:00Z',
      token_id: 'abc',
      eligible_for_trade: true,
    });
    strictEqual(out.length, 1);
    strictEqual(out[0].id, 'meta');
    strictEqual(out[0].entries.length, 4);
  });
  it('returns multiple sections in curated order Why > Conditions > Scoring > Meta', () => {
    const out = groupReasoningEntries({
      ts_iso: 'x',
      score: 0.5,
      decision: { kind: 'enter' },
      conditions: { a: 1 },
    });
    // Four sections: why / conditions / scoring / meta (ts_iso).
    strictEqual(out.length, 4);
    strictEqual(out[0].id, 'why');
    strictEqual(out[1].id, 'conditions');
    strictEqual(out[2].id, 'scoring');
    strictEqual(out[3].id, 'meta');
  });
  it('drops empty sections (Why absent → no Why section in output)', () => {
    const out = groupReasoningEntries({ score: 0.5, rank: 1 });
    strictEqual(out.length, 1);
    strictEqual(out[0].id, 'scoring');
  });
  it('routes unknown top-level keys to Meta (no silent drop)', () => {
    const out = groupReasoningEntries({
      future_field: 'someday',
      score: 0.5,
    });
    // 'future_field' lands in Meta (defensive). Score lands in
    // Scoring. Two sections expected.
    const meta = out.find((s) => s.id === 'meta');
    ok(meta, 'meta section exists');
    const found = meta.entries.find(([k]) => k === 'future_field');
    ok(found, 'future_field routed to meta');
  });
  it('does not mutate the input object', () => {
    const input = { decision: { kind: 'enter' }, score: 0.5 };
    const snapshot = JSON.stringify(input);
    groupReasoningEntries(input);
    strictEqual(JSON.stringify(input), snapshot);
  });
});

// ─── hasReasoningDetails ───────────────────────────────────────────

describe('hasReasoningDetails', () => {
  it('false for null', () => {
    strictEqual(hasReasoningDetails(null), false);
  });
  it('false for undefined', () => {
    strictEqual(hasReasoningDetails(undefined), false);
  });
  it('false for {}', () => {
    strictEqual(hasReasoningDetails({}), false);
  });
  it('false for non-object', () => {
    strictEqual(hasReasoningDetails('hello'), false);
    strictEqual(hasReasoningDetails(42), false);
  });
  it('true when at least one known key is present', () => {
    strictEqual(hasReasoningDetails({ score: 0.5 }), true);
    strictEqual(hasReasoningDetails({ decision: {} }), true);
    strictEqual(hasReasoningDetails({ conditions: {} }), true);
  });
  it('true for unknown-only keys (defensive — unknown lands in Meta)', () => {
    strictEqual(hasReasoningDetails({ future_field: 'x' }), true);
  });
});

// ─── formatReasoningValue ─────────────────────────────────────────

describe('formatReasoningValue', () => {
  it('null / undefined → em-dash', () => {
    strictEqual(formatReasoningValue(null), '—');
    strictEqual(formatReasoningValue(undefined), '—');
  });
  it('boolean → "true" / "false"', () => {
    strictEqual(formatReasoningValue(true), 'true');
    strictEqual(formatReasoningValue(false), 'false');
  });
  it('integer with thousands separators', () => {
    strictEqual(formatReasoningValue(1234), '1 234');
    strictEqual(formatReasoningValue(1234567), '1 234 567');
    strictEqual(formatReasoningValue(0), '0');
  });
  it('negative integer keeps the minus', () => {
    strictEqual(formatReasoningValue(-1500), '-1 500');
  });
  it('positive integer gets NO + prefix (context disambiguates sign)', () => {
    strictEqual(formatReasoningValue(1500), '1 500');
  });
  it('float caps at 6 decimals and trims trailing zeros', () => {
    strictEqual(formatReasoningValue(0.005), '0.005');
    strictEqual(formatReasoningValue(0.5670358354681183), '0.567036');
  });
  it('NaN / Infinity → em-dash', () => {
    strictEqual(formatReasoningValue(NaN), '—');
    strictEqual(formatReasoningValue(Infinity), '—');
    strictEqual(formatReasoningValue(-Infinity), '—');
  });
  it('string passes through', () => {
    strictEqual(formatReasoningValue('hello'), 'hello');
    strictEqual(formatReasoningValue(''), '');
  });
  it('bigint renders as decimal string', () => {
    strictEqual(formatReasoningValue(123456789n), '123456789');
  });
  it('empty array → "[]"', () => {
    strictEqual(formatReasoningValue([]), '[]');
  });
  it('non-empty array → "[N items]"', () => {
    strictEqual(formatReasoningValue([1, 2, 3]), '[3 items]');
    strictEqual(formatReasoningValue([1]), '[1 item]');
  });
  it('empty object → "{}"', () => {
    strictEqual(formatReasoningValue({}), '{}');
  });
  it('non-empty object → "{N fields}"', () => {
    strictEqual(formatReasoningValue({ a: 1, b: 2 }), '{2 fields}');
    strictEqual(formatReasoningValue({ a: 1 }), '{1 field}');
  });
});

// ─── formatSatsValue ──────────────────────────────────────────────

describe('formatSatsValue', () => {
  it('null / undefined → null (caller decides whether to render)', () => {
    strictEqual(formatSatsValue(null), null);
    strictEqual(formatSatsValue(undefined), null);
  });
  it('bigint → "N sat (X.XXXXXXXX BCH)" with thousands separators', () => {
    strictEqual(formatSatsValue(500000n), '500 000 sat (0.00500000 BCH)');
    strictEqual(formatSatsValue(100000000n), '100 000 000 sat (1.00000000 BCH)');
    strictEqual(formatSatsValue(0n), '0 sat (0.00000000 BCH)');
  });
  it('string → parsed as bigint', () => {
    strictEqual(formatSatsValue('500000'), '500 000 sat (0.00500000 BCH)');
  });
  it('number → truncated to int then formatted', () => {
    strictEqual(formatSatsValue(500000.7), '500 000 sat (0.00500000 BCH)');
  });
  it('negative sat amount uses absolute value + "- " prefix', () => {
    strictEqual(formatSatsValue(-25000n), '-25 000 sat (0.00025000 BCH)');
  });
  it('unparseable string → null', () => {
    strictEqual(formatSatsValue('not a number'), null);
    strictEqual(formatSatsValue('abc'), null);
  });
  it('non-string / non-number / non-bigint → null', () => {
    strictEqual(formatSatsValue({}), null);
    strictEqual(formatSatsValue([]), null);
    strictEqual(formatSatsValue(true), null);
  });
});

// ─── isSatsKey ────────────────────────────────────────────────────

describe('isSatsKey', () => {
  it('exact match for "sats"', () => {
    strictEqual(isSatsKey('sats'), true);
  });
  it('suffix match for "*_sats"', () => {
    strictEqual(isSatsKey('bch_spent_sats'), true);
    strictEqual(isSatsKey('hwm_sats'), true);
    strictEqual(isSatsKey('bch_received_sats'), true);
    strictEqual(isSatsKey('bch_budget_sats'), true);
  });
  it('known special keys regardless of suffix shape', () => {
    strictEqual(isSatsKey('hwm_sats'), true);
    strictEqual(isSatsKey('bch_budget_sats'), true);
  });
  it('non-sats keys return false', () => {
    strictEqual(isSatsKey('score'), false);
    strictEqual(isSatsKey('rank'), false);
    strictEqual(isSatsKey('sats_bch'), false); // reverse order
    strictEqual(isSatsKey(''), false);
  });
  it('non-string returns false', () => {
    strictEqual(isSatsKey(null), false);
    strictEqual(isSatsKey(undefined), false);
    strictEqual(isSatsKey(123), false);
  });
});

// ─── isSensitiveKey ──────────────────────────────────────────────

describe('isSensitiveKey', () => {
  it('matches WIF / mnemonic / seed / priv / secret / xprv / private_key / passphrase (case-insensitive)', () => {
    strictEqual(isSensitiveKey('wif'), true);
    strictEqual(isSensitiveKey('WIF'), true);
    strictEqual(isSensitiveKey('Wif'), true);
    strictEqual(isSensitiveKey('mnemonic'), true);
    strictEqual(isSensitiveKey('MNEMONIC'), true);
    strictEqual(isSensitiveKey('seed'), true);
    strictEqual(isSensitiveKey('seed_phrase'), true);
    strictEqual(isSensitiveKey('priv'), true);
    strictEqual(isSensitiveKey('private_key'), true);
    strictEqual(isSensitiveKey('privateKey'), true);
    strictEqual(isSensitiveKey('secret'), true);
    strictEqual(isSensitiveKey('xprv'), true);
    strictEqual(isSensitiveKey('passphrase'), true);
  });
  it('matches when key CONTAINS the pattern (defensive)', () => {
    strictEqual(isSensitiveKey('user_wif'), true);
    strictEqual(isSensitiveKey('wallet_mnemonic'), true);
    strictEqual(isSensitiveKey('api_secret_key'), true);
    strictEqual(isSensitiveKey('xprv_mainnet'), true);
  });
  it('non-sensitive keys return false', () => {
    strictEqual(isSensitiveKey('token_id'), false);
    strictEqual(isSensitiveKey('score'), false);
    strictEqual(isSensitiveKey('reasoning'), false);
    strictEqual(isSensitiveKey('sats'), false);
    strictEqual(isSensitiveKey('eligible_for_trade'), false);
  });
  it('non-string returns false', () => {
    strictEqual(isSensitiveKey(null), false);
    strictEqual(isSensitiveKey(undefined), false);
    strictEqual(isSensitiveKey(42), false);
    strictEqual(isSensitiveKey({}), false);
  });
});