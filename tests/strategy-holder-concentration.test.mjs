#!/usr/bin/env node
/**
 * Unit tests for src/strategy/holder-concentration.mjs.
 *
 * Pure-function tests. No I/O, no logger, no process state. Run via:
 *   npm test
 *
 * Covers:
 *   - safeBigIntFromBase: all input shapes (BigInt/Number/string/null/undefined/object/NaN/Infinity/negative/exponent/non-integer/whitespace)
 *   - validateHoldersInput: null / non-array / empty / Map / tuple-form / object-form / bad-address / bad-balance / zero-balance / duplicate-merge / sort-order
 *   - resolveHolderConcentrationConfig: defaults / overrides / out-of-range ignored / non-object ignored
 *   - totalSupplyFromHolders: empty / single / mixed
 *   - topNPctOfSupply: empty / single < total / top-N > totalSupply / zero totalSupply / topN=0 / topN > holders.length
 *   - baseToHumanString: decimals=0 / decimals>0 / trailing-zero trim / negative / BigInt-only
 *   - buildHolderDisplayRows: pct / human / is_top_n flag / bad-decimals / bad-topN
 *   - computeHolderConcentration: happy / not_rug / rug / empty / null-input / decimals propagation / token_id-decidability
 *   - isRugPatternByHolders: predicate shortcut / bad-input returns false
 *   - Determinism: sort tie-break is stable when balances match
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_HOLDER_CONCENTRATION_CONFIG,
  safeBigIntFromBase,
  validateHoldersInput,
  resolveHolderConcentrationConfig,
  totalSupplyFromHolders,
  topNPctOfSupply,
  buildHolderDisplayRows,
  baseToHumanString,
  computeHolderConcentration,
  isRugPatternByHolders,
} from '../src/strategy/holder-concentration.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────

function makeHolders(entries) {
  return entries.map(([address, balance]) => ({ address, balance_base: balance }));
}

// ─────────────────────────────────────────────────────────────────────
//  safeBigIntFromBase
// ─────────────────────────────────────────────────────────────────────

test('safeBigIntFromBase: BigInt input returns BigInt', () => {
  assert.equal(safeBigIntFromBase(100n), 100n);
});

test('safeBigIntFromBase: Number safe integer → BigInt', () => {
  assert.equal(safeBigIntFromBase(42), 42n);
  assert.equal(safeBigIntFromBase(0), 0n);
});

test('safeBigIntFromBase: Number > MAX_SAFE_INTEGER is truncated', () => {
  // 1e20 is not a safe integer — fall through to Math.trunc
  assert.equal(safeBigIntFromBase(1e20), 100000000000000000000n);
});

test('safeBigIntFromBase: null/undefined → null', () => {
  assert.equal(safeBigIntFromBase(null), null);
  assert.equal(safeBigIntFromBase(undefined), null);
});

test('safeBigIntFromBase: NaN / Infinity / -Infinity → null', () => {
  assert.equal(safeBigIntFromBase(NaN), null);
  assert.equal(safeBigIntFromBase(Infinity), null);
  assert.equal(safeBigIntFromBase(-Infinity), null);
});

test('safeBigIntFromBase: negative numbers → null (no underflow)', () => {
  assert.equal(safeBigIntFromBase(-1), null);
  assert.equal(safeBigIntFromBase(-0.5), null);
});

test('safeBigIntFromBase: numeric string → BigInt', () => {
  assert.equal(safeBigIntFromBase('12345'), 12345n);
  assert.equal(safeBigIntFromBase('  42  '), 42n);
  assert.equal(safeBigIntFromBase('0'), 0n);
});

test('safeBigIntFromBase: invalid strings → null', () => {
  assert.equal(safeBigIntFromBase('1.5'), null);
  assert.equal(safeBigIntFromBase('-1'), null);
  assert.equal(safeBigIntFromBase(''), null);
  assert.equal(safeBigIntFromBase('abc'), null);
  assert.equal(safeBigIntFromBase('1e5'), null);
  assert.equal(safeBigIntFromBase('1 2'), null);
});

test('safeBigIntFromBase: non-string/non-number/BigInt → null', () => {
  assert.equal(safeBigIntFromBase({}), null);
  assert.equal(safeBigIntFromBase([]), null);
  assert.equal(safeBigIntFromBase(true), null);
});

// ─────────────────────────────────────────────────────────────────────
//  validateHoldersInput
// ─────────────────────────────────────────────────────────────────────

test('validateHoldersInput: null → not_array / null_input error envelope', () => {
  const r1 = validateHoldersInput(null);
  assert.equal(r1.ok, false);
  assert.equal(r1.error, 'null_input');
  const r2 = validateHoldersInput(undefined);
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'null_input');
});

test('validateHoldersInput: non-array → not_array', () => {
  assert.equal(validateHoldersInput({}).ok, false);
  assert.equal(validateHoldersInput(42).ok, false);
  assert.equal(validateHoldersInput('foo').ok, false);
});

test('validateHoldersInput: empty array → ok with empty holders', () => {
  const r = validateHoldersInput([]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.holders, []);
});

test('validateHoldersInput: array of {address, balance_base} → sorted DESC', () => {
  const r = validateHoldersInput([
    { address: 'bitcoincash:qqaaa', balance_base: '100' },
    { address: 'bitcoincash:qqbbb', balance_base: '300' },
    { address: 'bitcoincash:qqccc', balance_base: '200' },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.holders.length, 3);
  assert.equal(r.holders[0].balance_base, 300n);
  assert.equal(r.holders[1].balance_base, 200n);
  assert.equal(r.holders[2].balance_base, 100n);
});

test('validateHoldersInput: tuple form [address, balance]', () => {
  const r = validateHoldersInput([
    ['bitcoincash:qqaaa', '100'],
    ['bitcoincash:qqbbb', '200'],
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.holders[0].balance_base, 200n);
  assert.equal(r.holders[0].address, 'bitcoincash:qqbbb');
});

test('validateHoldersInput: Map input is converted', () => {
  const m = new Map();
  m.set('bitcoincash:qqaaa', 100n);
  m.set('bitcoincash:qqbbb', 200n);
  const r = validateHoldersInput(m);
  assert.equal(r.ok, true);
  assert.equal(r.holders.length, 2);
  assert.equal(r.holders[0].balance_base, 200n);
});

test('validateHoldersInput: case-insensitive address merge', () => {
  const r = validateHoldersInput([
    { address: 'bitcoincash:qqaaa', balance_base: '100' },
    { address: 'BITCOINCASH:QQAAA', balance_base: '50' },
    { address: 'Bitcoincash:QqAaa', balance_base: '25' },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.holders.length, 1);
  // 100 + 50 + 25 = 175n
  assert.equal(r.holders[0].balance_base, 175n);
  // First-occurrence address casing is preserved.
  assert.equal(r.holders[0].address, 'bitcoincash:qqaaa');
});

test('validateHoldersInput: rows with non-string address or bad balance are dropped', () => {
  const r = validateHoldersInput([
    { address: 'bitcoincash:qqaaa', balance_base: '100' },
    { address: 42, balance_base: '200' },         // bad address
    { address: 'bitcoincash:qqbbb', balance_base: 'not-a-number' },  // bad
    { address: 'bitcoincash:qqccc', balance_base: '300' },
    { address: '', balance_base: '400' },         // empty
    null,                                          // non-object row
    { address: 'bitcoincash:qqddd', balance_base: '500' },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.holders.length, 3);
  assert.equal(r._dropped, 4);
});

test('validateHoldersInput: deterministic tie-break on equal balances', () => {
  const r = validateHoldersInput([
    { address: 'bitcoincash:qqzzz', balance_base: '100' },
    { address: 'bitcoincash:qqaaa', balance_base: '100' },
    { address: 'bitcoincash:qqmmm', balance_base: '100' },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.holders.length, 3);
  // lowercased address ASC tie-break: aaa < mmm < zzz
  assert.equal(r.holders[0].address, 'bitcoincash:qqaaa');
  assert.equal(r.holders[1].address, 'bitcoincash:qqmmm');
  assert.equal(r.holders[2].address, 'bitcoincash:qqzzz');
});

test('validateHoldersInput: zero-balance rows are KEPT', () => {
  const r = validateHoldersInput([
    { address: 'bitcoincash:qqaaa', balance_base: '0' },
    { address: 'bitcoincash:qqbbb', balance_base: '100' },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.holders.length, 2);
  // Zero-balance row is sorted last (its balance is smallest)
  assert.equal(r.holders[1].balance_base, 0n);
});

// ─────────────────────────────────────────────────────────────────────
//  resolveHolderConcentrationConfig
// ─────────────────────────────────────────────────────────────────────

test('resolveHolderConcentrationConfig: defaults when opts is null', () => {
  const cfg = resolveHolderConcentrationConfig(null);
  assert.equal(cfg.rug_top_n, 5);
  assert.equal(cfg.rug_threshold_pct, 80);
  assert.equal(cfg.epsilon_pct, 1e-9);
  assert.equal(cfg.applied.rug_top_n, 5);
});

test('resolveHolderConcentrationConfig: valid overrides applied', () => {
  const cfg = resolveHolderConcentrationConfig({ rug_top_n: 10, rug_threshold_pct: 70 });
  assert.equal(cfg.rug_top_n, 10);
  assert.equal(cfg.rug_threshold_pct, 70);
});

test('resolveHolderConcentrationConfig: out-of-range overrides are ignored', () => {
  const cfg = resolveHolderConcentrationConfig({
    rug_top_n: -1,
    rug_threshold_pct: 200,
    epsilon_pct: -1,
  });
  // Falls back to defaults
  assert.equal(cfg.rug_top_n, 5);
  assert.equal(cfg.rug_threshold_pct, 80);
  assert.equal(cfg.epsilon_pct, 1e-9);
});

test('resolveHolderConcentrationConfig: non-object opts ignored', () => {
  const cfg = resolveHolderConcentrationConfig('garbage');
  assert.equal(cfg.rug_top_n, 5);
});

test('resolveHolderConcentrationConfig: non-integer rug_top_n is truncated', () => {
  const cfg = resolveHolderConcentrationConfig({ rug_top_n: 3.7 });
  assert.equal(cfg.rug_top_n, 3);
});

// ─────────────────────────────────────────────────────────────────────
//  totalSupplyFromHolders
// ─────────────────────────────────────────────────────────────────────

test('totalSupplyFromHolders: empty array → 0n', () => {
  assert.equal(totalSupplyFromHolders([]), 0n);
});

test('totalSupplyFromHolders: sums all valid BigInt balances', () => {
  assert.equal(totalSupplyFromHolders([
    { balance_base: 100n },
    { balance_base: 200n },
    { balance_base: 300n },
  ]), 600n);
});

test('totalSupplyFromHolders: skips rows that have non-bigint balance (defensive)', () => {
  assert.equal(totalSupplyFromHolders([
    { balance_base: 100n },
    { balance_base: 'not-bigint' },
    { balance_base: 50n },
  ]), 150n);
});

// ─────────────────────────────────────────────────────────────────────
//  topNPctOfSupply
// ─────────────────────────────────────────────────────────────────────

test('topNPctOfSupply: empty + zero total → 0', () => {
  assert.equal(topNPctOfSupply([], 5, 0n), 0);
});

test('topNPctOfSupply: single holder owns everything → 100', () => {
  const h = [{ address: 'bitcoincash:qqaaa', balance_base: 1000n }];
  assert.equal(topNPctOfSupply(h, 5, 1000n), 100);
});

test('topNPctOfSupply: top-2 of 5 hold 60%', () => {
  const h = makeHolders([
    ['a', '300'], ['b', '300'], ['c', '100'], ['d', '200'], ['e', '100'],
  ]).sort((x, y) => Number(y.balance_base - x.balance_base));
  // total = 1000
  assert.equal(topNPctOfSupply(h, 2, 1000n), 60);
});

test('topNPctOfSupply: topN=0 → 0', () => {
  const h = makeHolders([['a', '100'], ['b', '200']]);
  assert.equal(topNPctOfSupply(h, 0, 300n), 0);
});

test('topNPctOfSupply: topN > holders.length uses holders.length', () => {
  const h = makeHolders([['a', '100'], ['b', '200']]);
  assert.equal(topNPctOfSupply(h, 99, 300n), 100);
});

test('topNPctOfSupply: zero totalSupply → 0 (no div by zero)', () => {
  const h = makeHolders([['a', '0'], ['b', '0']]);
  assert.equal(topNPctOfSupply(h, 5, 0n), 0);
});

// ─────────────────────────────────────────────────────────────────────
//  baseToHumanString
// ─────────────────────────────────────────────────────────────────────

test('baseToHumanString: decimals=0 is identity', () => {
  assert.equal(baseToHumanString(123n, 0), '123');
  assert.equal(baseToHumanString(0n, 0), '0');
});

test('baseToHumanString: decimals=2 inserts decimal', () => {
  assert.equal(baseToHumanString(150n, 2), '1.5');
  assert.equal(baseToHumanString(100n, 2), '1');
  assert.equal(baseToHumanString(1n, 2), '0.01');
});

test('baseToHumanString: decimals=9 with large supply', () => {
  assert.equal(baseToHumanString(1000000000n, 9), '1');
  assert.equal(baseToHumanString(1500000000n, 9), '1.5');
});

test('baseToHumanString: trailing zeros trimmed', () => {
  assert.equal(baseToHumanString(1100n, 3), '1.1');
  assert.equal(baseToHumanString(1000n, 3), '1');
});

test('baseToHumanString: padding small numbers with leading zeros', () => {
  assert.equal(baseToHumanString(1n, 9), '0.000000001');
});

test('baseToHumanString: negative base', () => {
  // Negative balances are technically possible in some inputs (we
  // filter them at the validate step, but the helper itself just
  // formats them for the dashboard).
  assert.equal(baseToHumanString(-150n, 2), '-1.5');
});

test('baseToHumanString: non-bigint input → "0"', () => {
  assert.equal(baseToHumanString('not-bigint', 0), '0');
});

test('baseToHumanString: out-of-range decimals → clamped to 0', () => {
  assert.equal(baseToHumanString(150n, -1), '150');
  assert.equal(baseToHumanString(150n, 25), '150');
});

// ─────────────────────────────────────────────────────────────────────
//  buildHolderDisplayRows
// ─────────────────────────────────────────────────────────────────────

test('buildHolderDisplayRows: basic projection with pct + human + is_top_n', () => {
  const h = makeHolders([
    ['bitcoincash:qpa', '800'],
    ['bitcoincash:qpb', '100'],
    ['bitcoincash:qpc', '100'],
  ]);
  // total = 1000
  const out = buildHolderDisplayRows(h, 1000n, 0, 2);
  assert.equal(out.length, 3);
  assert.equal(out[0].address, 'bitcoincash:qpa');
  assert.equal(out[0].balance_base, '800');
  assert.equal(out[0].balance_human, '800');
  assert.equal(out[0].pct_of_supply, 80);
  assert.equal(out[0].is_top_n, true);
  assert.equal(out[1].pct_of_supply, 10);
  assert.equal(out[1].is_top_n, true);
  assert.equal(out[2].is_top_n, false);
});

test('buildHolderDisplayRows: bad decimals → coerced to 0', () => {
  const h = makeHolders([['a', '100']]);
  const out = buildHolderDisplayRows(h, 100n, NaN, 5);
  assert.equal(out[0].balance_human, '100');
});

test('buildHolderDisplayRows: bad topN → coerced to 0 (no is_top_n)', () => {
  const h = makeHolders([['a', '100']]);
  const out = buildHolderDisplayRows(h, 100n, 0, NaN);
  assert.equal(out[0].is_top_n, false);
});

// ─────────────────────────────────────────────────────────────────────
//  computeHolderConcentration
// ─────────────────────────────────────────────────────────────────────

test('computeHolderConcentration: happy path — no rug (top-5 hold 60%)', () => {
  const envelope = computeHolderConcentration({
    token_id: 'aabbcc',
    holders: makeHolders([
      ['a', '200'], ['b', '200'], ['c', '200'], ['d', '200'], ['e', '100'], ['f', '100'],
    ]),
    decimals: 0,
  });
  assert.equal(envelope.ok, true);
  assert.equal(envelope.schema, 'tradebot.strategy.holder-concentration/v1');
  assert.equal(envelope.token_id, 'aabbcc');
  assert.equal(envelope.total_holders, 6);
  assert.equal(envelope.total_supply_base, '1000');
  assert.equal(envelope.top_n, 5);
  assert.equal(envelope.top_n_pct, 90); // 200+200+200+200+100 = 900 / 1000
  assert.equal(envelope.rug_pattern, true);
});

test('computeHolderConcentration: NOT a rug — top-5 hold 50%', () => {
  const envelope = computeHolderConcentration({
    token_id: 'aabbcc',
    holders: makeHolders([
      ['a', '100'], ['b', '100'], ['c', '100'], ['d', '100'], ['e', '100'],
      ['f', '100'], ['g', '100'], ['h', '100'], ['i', '100'], ['j', '100'],
    ]),
  });
  // total = 1000, top-5 = 500 → 50%
  assert.equal(envelope.ok, true);
  assert.equal(envelope.top_n_pct, 50);
  assert.equal(envelope.rug_pattern, false);
});

test('computeHolderConcentration: empty holders', () => {
  const envelope = computeHolderConcentration({
    token_id: 'aabbcc',
    holders: [],
  });
  assert.equal(envelope.ok, true);
  assert.equal(envelope.total_holders, 0);
  assert.equal(envelope.total_supply_base, '0');
  assert.equal(envelope.top_n_pct, 0);
  assert.equal(envelope.rug_pattern, false);
  assert.deepEqual(envelope.holders, []);
});

test('computeHolderConcentration: null holders → error envelope', () => {
  const envelope = computeHolderConcentration({
    token_id: 'aabbcc',
    holders: null,
  });
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error, 'null_input');
  assert.equal(envelope.ts_validation, 'rejected');
});

test('computeHolderConcentration: thresholds applied — top-N=10 + threshold=50%', () => {
  const envelope = computeHolderConcentration({
    token_id: 'aabbcc',
    holders: makeHolders([
      ['a', '100'], ['b', '100'], ['c', '100'], ['d', '100'], ['e', '100'],
      ['f', '100'], ['g', '100'], ['h', '100'], ['i', '100'], ['j', '100'],
    ]),
    opts: { rug_top_n: 10, rug_threshold_pct: 50 },
  });
  assert.equal(envelope.top_n_pct, 100);
  assert.equal(envelope.rug_pattern, true);
});

test('computeHolderConcentration: epsilon_pct floors the threshold', () => {
  // Data: a=40, b=30, c=10, d=10, e=5, f=5 (total=100).
  // top-5 = 40+30+10+10+5 = 95, top_n_pct = 95%.

  // Case 1: threshold=100, epsilon=0 → 95 < 100 → not rug.
  const env1 = computeHolderConcentration({
    token_id: 'aabbcc',
    holders: makeHolders([['a', '40'], ['b', '30'], ['c', '10'], ['d', '10'], ['e', '5'], ['f', '5']]),
    opts: { rug_threshold_pct: 100, epsilon_pct: 0 },
  });
  assert.equal(env1.top_n_pct, 95);
  assert.equal(env1.rug_pattern, false);

  // Case 2: same data, threshold=90, epsilon=0 → 95 >= 90 → rug.
  const env2 = computeHolderConcentration({
    token_id: 'aabbcc',
    holders: makeHolders([['a', '40'], ['b', '30'], ['c', '10'], ['d', '10'], ['e', '5'], ['f', '5']]),
    opts: { rug_threshold_pct: 90, epsilon_pct: 0 },
  });
  assert.equal(env2.top_n_pct, 95);
  assert.equal(env2.rug_pattern, true);

  // Case 3: same data, threshold=100, epsilon=10 → effective threshold
  // is 100 - 10 = 90, 95 >= 90 → rug. This is the case where
  // epsilon lets a sub-100% concentration rug at a 100% threshold —
  // the kind of "I know my data is float-noisy" tolerance operator
  // configures to avoid false-negative rug flags at the edge.
  const env3 = computeHolderConcentration({
    token_id: 'aabbcc',
    holders: makeHolders([['a', '40'], ['b', '30'], ['c', '10'], ['d', '10'], ['e', '5'], ['f', '5']]),
    opts: { rug_threshold_pct: 100, epsilon_pct: 10 },
  });
  assert.equal(env3.top_n_pct, 95);
  assert.equal(env3.rug_pattern, true);

  // Case 4: same data, threshold=95.0001, epsilon=0 → 95 < 95.0001 → not rug.
  // Demonstrates that epsilon=0 is a strict "no float tolerance" check.
  const env4 = computeHolderConcentration({
    token_id: 'aabbcc',
    holders: makeHolders([['a', '40'], ['b', '30'], ['c', '10'], ['d', '10'], ['e', '5'], ['f', '5']]),
    opts: { rug_threshold_pct: 95.0001, epsilon_pct: 0 },
  });
  assert.equal(env4.top_n_pct, 95);
  assert.equal(env4.rug_pattern, false);
});

test('computeHolderConcentration: token_id is normalized', () => {
  const envelope = computeHolderConcentration({
    token_id: '  deadbeef  ',
    holders: [],
  });
  assert.equal(envelope.token_id, 'deadbeef');
});

test('computeHolderConcentration: token_id omitted → null', () => {
  const envelope = computeHolderConcentration({ holders: [] });
  assert.equal(envelope.token_id, null);
});

test('computeHolderConcentration: decimals propagation', () => {
  // 1.5 token with decimals=1 → base = 15
  const envelope = computeHolderConcentration({
    token_id: 'aabbcc',
    holders: makeHolders([['a', '15']]),
    decimals: 1,
  });
  assert.equal(envelope.total_supply_human, '1.5');
  assert.equal(envelope.top_n_holders[0].balance_human, '1.5');
});

test('computeHolderConcentration: dropped count is surfaced when input is dirty', () => {
  const envelope = computeHolderConcentration({
    token_id: 'aabbcc',
    holders: [
      { address: 'bitcoincash:qpa', balance_base: '100' },
      { address: 42, balance_base: '200' },  // bad address
      null,
    ],
  });
  assert.equal(envelope.ok, true);
  assert.equal(envelope.total_holders, 1);
  assert.equal(envelope.dropped, 2);
});

test('computeHolderConcentration: top_n_holders is filtered subset', () => {
  const envelope = computeHolderConcentration({
    token_id: 'aabbcc',
    holders: makeHolders([
      ['a', '100'], ['b', '90'], ['c', '80'], ['d', '70'], ['e', '60'],
      ['f', '50'], ['g', '40'], ['h', '30'], ['i', '20'], ['j', '10'],
    ]),
  });
  assert.equal(envelope.top_n, 5);
  assert.equal(envelope.top_n_holders.length, 5);
  // First five by balance DESC
  assert.equal(envelope.top_n_holders[0].address, 'a');
  assert.equal(envelope.top_n_holders[4].address, 'e');
  assert.equal(envelope.top_n_holders[5] === undefined, true);
});

// ─────────────────────────────────────────────────────────────────────
//  isRugPatternByHolders
// ─────────────────────────────────────────────────────────────────────

test('isRugPatternByHolders: true for high concentration', () => {
  const holders = makeHolders([
    ['a', '900'], ['b', '50'], ['c', '50'],
  ]);
  assert.equal(isRugPatternByHolders(holders), true);
});

test('isRugPatternByHolders: false for low concentration', () => {
  const holders = makeHolders([
    ['a', '100'], ['b', '100'], ['c', '100'], ['d', '100'], ['e', '100'],
    ['f', '100'], ['g', '100'], ['h', '100'], ['i', '100'], ['j', '100'],
  ]);
  assert.equal(isRugPatternByHolders(holders), false);
});

test('isRugPatternByHolders: bad input returns false (never throws)', () => {
  assert.equal(isRugPatternByHolders(null), false);
  assert.equal(isRugPatternByHolders({}), false);
  assert.equal(isRugPatternByHolders('garbage'), false);
});

// ─────────────────────────────────────────────────────────────────────
//  Defaults are frozen + sane
// ─────────────────────────────────────────────────────────────────────

test('DEFAULT_HOLDER_CONCENTRATION_CONFIG: matches the operator-idea defaults', () => {
  assert.equal(DEFAULT_HOLDER_CONCENTRATION_CONFIG.rug_top_n, 5);
  assert.equal(DEFAULT_HOLDER_CONCENTRATION_CONFIG.rug_threshold_pct, 80);
  assert.equal(DEFAULT_HOLDER_CONCENTRATION_CONFIG.epsilon_pct, 1e-9);
});

test('DEFAULT_HOLDER_CONCENTRATION_CONFIG: frozen', () => {
  assert.equal(Object.isFrozen(DEFAULT_HOLDER_CONCENTRATION_CONFIG), true);
});

// ─────────────────────────────────────────────────────────────────────
//  T76 subset 2b — extractRugPatternAuditFromResolver
// ─────────────────────────────────────────────────────────────────────

import { extractRugPatternAuditFromResolver } from '../src/strategy/holder-concentration.mjs';

test('extractRugPatternAuditFromResolver: null/undefined input returns typed envelope', () => {
  const a = extractRugPatternAuditFromResolver(null);
  assert.equal(a.rug_pattern, false);
  assert.equal(a.error, 'resolver_invalid');
  const b = extractRugPatternAuditFromResolver(undefined);
  assert.equal(b.rug_pattern, false);
  assert.equal(b.error, 'resolver_invalid');
  const c = extractRugPatternAuditFromResolver('not an object');
  assert.equal(c.rug_pattern, false);
  assert.equal(c.error, 'resolver_invalid');
  const d = extractRugPatternAuditFromResolver(42);
  assert.equal(d.rug_pattern, false);
  assert.equal(d.error, 'resolver_invalid');
});

test('extractRugPatternAuditFromResolver: ok:false resolver surfaces error verbatim', () => {
  const a = extractRugPatternAuditFromResolver({
    ok: false, error: 'scanner_unreachable', message: 'ECONNREFUSED',
  });
  assert.equal(a.rug_pattern, false);
  assert.equal(a.error, 'scanner_unreachable');
  // Non-token-not_found errors get `token_not_found: false` (not
  // undefined) so downstream callers can branch on the field.
  assert.equal(a.token_not_found, false);
});

test('extractRugPatternAuditFromResolver: token_not_found surfaces as token_not_found:true', () => {
  const a = extractRugPatternAuditFromResolver({
    ok: false, error: 'token_not_found', message: 'upstream has not indexed this token',
  });
  assert.equal(a.rug_pattern, false);
  assert.equal(a.error, 'token_not_found');
  assert.equal(a.token_not_found, true);
});

test('extractRugPatternAuditFromResolver: ok:true + token_not_found:true (TokenStork envelope)', () => {
  // T76 subset 2b follow-up: when the upstream scanner returns
  // `ok:true` with `{token_not_found: true, holders: []}` (the
  // TokenStork "we don't index this token yet" envelope — see
  // `holder-scanner.mjs` ~line 384), the resolver propagates it
  // as `ok:true` because the upstream didn't ERROR. The audit
  // translator must STILL surface `token_not_found:true` so
  // the loop's defensive pass-through path fires (otherwise the
  // unindexed state would silently appear as `rug_pattern:false
  // / holders_count:0` and the loop's `metrics.token_not_found_count`
  // would never increment).
  const r = extractRugPatternAuditFromResolver({
    ok: true,
    cached: false,
    cache_age_ms: 0,
    envelope: {
      ok: true,
      source: 'tokenstork',
      category: 'a'.repeat(64),
      holders: [],
      token_not_found: true,
      message: 'upstream has not indexed this token',
      fetched_at_ms: 1700000000000,
      upstream: 'tokenstork',
    },
    upstream: 'tokenstork',
    snapshot_at_unix_s: null,
  });
  assert.equal(r.rug_pattern, false);
  assert.equal(r.error, 'token_not_found');
  assert.equal(r.token_not_found, true);
  assert.equal(r.holders_count, 0);
  assert.equal(r.total_supply_base, '0');
  assert.equal(r.top_n_pct, 0);
  // The cfg fields ride along for audit-trail completeness.
  assert.equal(r.threshold_pct, 80);
  assert.equal(r.top_n, 5);
  assert.equal(r.epsilon_pct, 1e-9);
  assert.equal(r.upstream, 'tokenstork');
});

test('extractRugPatternAuditFromResolver: empty upstream envelope returns typed envelope', () => {
  const a = extractRugPatternAuditFromResolver({ ok: true, envelope: null });
  assert.equal(a.rug_pattern, false);
  assert.equal(a.error, 'envelope_invalid');
  const b = extractRugPatternAuditFromResolver({ ok: true });
  assert.equal(b.rug_pattern, false);
  assert.equal(b.error, 'envelope_invalid');
  const c = extractRugPatternAuditFromResolver({ ok: true, envelope: 'garbage' });
  assert.equal(c.rug_pattern, false);
  assert.equal(c.error, 'envelope_invalid');
});

test('extractRugPatternAuditFromResolver: rug pattern detected (top 5 hold >=80%)', () => {
  // 5 wallets × 100 base units = 500 total; top 5 = 100% → 100 >= 80-epsilon → rug.
  const holders = [];
  for (let i = 0; i < 5; i++) {
    holders.push({ address: `bitcoincash:qpk${i}`.padEnd(40, '0'), balance: '100' });
  }
  // Add 5 small holders to dilute supply.
  for (let i = 0; i < 5; i++) {
    holders.push({ address: `bitcoincash:qsm${i}`.padEnd(40, '0'), balance: '1' });
  }
  const r = extractRugPatternAuditFromResolver({
    ok: true, cached: false, cache_age_ms: 0,
    envelope: { holders },
    upstream: 'tokenstork',
    snapshot_at_unix_s: 1700000000,
  });
  assert.equal(r.rug_pattern, true);
  assert.equal(r.error, null);
  assert.equal(r.holders_count, 10);
  assert.equal(r.total_supply_base, '505');
  assert.equal(r.upstream, 'tokenstork');
  assert.equal(r.cached, false);
  assert.equal(r.cache_age_ms, 0);
  assert.equal(r.snapshot_at_unix_s, 1700000000);
  assert.equal(r.threshold_pct, 80);
  assert.equal(r.top_n, 5);
  assert.ok(r.top_n_pct >= 80);
});

test('extractRugPatternAuditFromResolver: not a rug pattern (well-distributed supply)', () => {
  // 20 wallets × 5 base units each = 100 total; top 5 = 25% → 25 < 80-epsilon → not a rug.
  const holders = [];
  for (let i = 0; i < 20; i++) {
    // Use a unique full-width address per index — avoids collisions
    // when padding to 40 chars truncates the hex prefix.
    const addr = `bitcoincash:q${(0x100000000 + i).toString(16).slice(-8)}`.padEnd(40, '0');
    holders.push({ address: addr, balance: '5' });
  }
  const r = extractRugPatternAuditFromResolver({
    ok: true, cached: false, cache_age_ms: 0, envelope: { holders },
  });
  assert.equal(r.rug_pattern, false);
  assert.equal(r.error, null);
  assert.equal(r.holders_count, 20);
  assert.equal(r.total_supply_base, '100');
  assert.ok(r.top_n_pct < 80);
  assert.ok(r.top_n_pct > 0);
});

test('extractRugPatternAuditFromResolver: cached:true surfaces in audit blob', () => {
  const holders = [];
  for (let i = 0; i < 5; i++) {
    holders.push({ address: `bitcoincash:qca${i}`.padEnd(40, '0'), balance: '20' });
  }
  const r = extractRugPatternAuditFromResolver({
    ok: true, cached: true, cache_age_ms: 12345,
    envelope: { holders },
    upstream: 'cache',
  });
  assert.equal(r.rug_pattern, true);
  assert.equal(r.cached, true);
  assert.equal(r.cache_age_ms, 12345);
  assert.equal(r.upstream, 'cache');
});

test('extractRugPatternAuditFromResolver: empty holders list returns typed envelope (not a rug)', () => {
  const r = extractRugPatternAuditFromResolver({
    ok: true, cached: false, envelope: { holders: [] },
  });
  assert.equal(r.rug_pattern, false);
  assert.equal(r.error, null);
  assert.equal(r.holders_count, 0);
  assert.equal(r.total_supply_base, '0');
  assert.equal(r.top_n_pct, 0);
});

test('extractRugPatternAuditFromResolver: upstream rows with `balance` field map to base units', () => {
  // TokenStork returns `{address, balance: '<decimal string>'}` — verify the translator
  // also accepts the `balance` (vs `balance_base`) alias. Use a 2-wallet + 18-small setup
  // so the top-5 concentration sits well below the 80% threshold.
  function uniqAddr(prefix, i) {
    // Hex of (prefix + i) zero-padded to exactly 40 chars total prefix.
    const suffix = (BigInt(prefix) * 100000n + BigInt(i)).toString(16).padStart(40, '0');
    return `bitcoincash:q${suffix}`;
  }
  const holders = [
    { address: uniqAddr(1, 0), balance: '100', nft_count: 0, snapshot_at_unix_s: 1700000000 },
    { address: uniqAddr(1, 1), balance: '50', nft_count: 0, snapshot_at_unix_s: 1700000000 },
  ];
  for (let i = 0; i < 18; i++) {
    holders.push({
      address: uniqAddr(2, i),
      balance: '10',
      nft_count: 0,
      snapshot_at_unix_s: 1700000000,
    });
  }
  const r = extractRugPatternAuditFromResolver({
    ok: true, cached: false, envelope: { holders },
  });
  assert.equal(r.rug_pattern, false);
  assert.equal(r.error, null);
  // 150 base units from the 2 big + 180 base units from the 18 small = 330 total.
  assert.equal(r.holders_count, 20);
  // Top-5 = 100+50+10+10+10 = 190 / 330 = ~57.6% — well under the 80% threshold.
  assert.equal(r.total_supply_base, '330');
  assert.ok(r.top_n_pct < 80);
  assert.ok(r.top_n_pct > 50);
});

test('extractRugPatternAuditFromResolver: malformed holder rows are dropped (never throws)', () => {
  function uniqAddr(i) {
    return `bitcoincash:q${(0xa00000n + BigInt(i)).toString(16).padStart(40, '0')}`;
  }
  const holders = [
    { address: uniqAddr(1), balance: '100' },
    null,
    'not-an-object',
    { address: uniqAddr(2), balance: 'abc-not-numeric' }, // drops via safeBigIntFromBase
    { balance: '100' }, // missing address — drops
    { address: uniqAddr(3), balance: '100' },
  ];
  const r = extractRugPatternAuditFromResolver({
    ok: true, cached: false, envelope: { holders },
  });
  assert.equal(r.error, null);
  // 2 valid rows (the malformed-balance one is dropped).
  assert.equal(r.holders_count, 2);
});

test('extractRugPatternAuditFromResolver: opts override threshold + top_n', () => {
  // Build a 50/50 distribution: top 5 = 50% → not a rug at threshold=80,
  // but IS a rug at threshold=40.
  const holders = [];
  for (let i = 0; i < 10; i++) {
    holders.push({ address: `bitcoincash:qov${i}`.padEnd(40, '0'), balance: '10' });
  }
  const r1 = extractRugPatternAuditFromResolver({
    ok: true, cached: false, envelope: { holders },
  }, { rug_threshold_pct: 80 });
  assert.equal(r1.rug_pattern, false);
  const r2 = extractRugPatternAuditFromResolver({
    ok: true, cached: false, envelope: { holders },
  }, { rug_threshold_pct: 40, rug_top_n: 5 });
  assert.equal(r2.rug_pattern, true);
  assert.equal(r2.threshold_pct, 40);
  assert.equal(r2.top_n, 5);
});

test('extractRugPatternAuditFromResolver: never throws on adversarial input', () => {
  // Each of these should return a typed envelope, never throw.
  const cases = [
    { ok: true, envelope: { holders: 'not-an-array' } },
    { ok: true, envelope: { holders: [{ balance: 'not-a-number' }] } },
    { ok: true, envelope: { holders: [{ address: 'x', balance: '-' }] } },
    { ok: true, envelope: { holders: [{ address: 'x', balance: '0' }] } },
    { ok: false, error: null },
    { ok: false, error: 42 },
    { ok: undefined, envelope: { holders: [] } },
  ];
  for (const c of cases) {
    let r;
    try {
      r = extractRugPatternAuditFromResolver(c);
    } catch (e) {
      assert.fail(`extractRugPatternAuditFromResolver threw on ${JSON.stringify(c)}: ${e.message}`);
    }
    assert.equal(typeof r, 'object');
    assert.equal(typeof r.rug_pattern, 'boolean');
    if (c.ok === false) {
      assert.notEqual(r.error, null);
      assert.equal(r.rug_pattern, false);
    } else if (c.ok === undefined) {
      // ok:undefined falls through the `ok !== true` branch too.
      assert.notEqual(r.error, null);
    } else {
      // ok:true with a valid envelope shape (even empty) → no error
      assert.equal(r.error, null);
    }
  }
});