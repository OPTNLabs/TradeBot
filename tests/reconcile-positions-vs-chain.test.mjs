#!/usr/bin/env node
// tests/reconcile-positions-vs-chain.test.mjs
//
// T47: pure-diff unit tests for the positions-vs-chain reconciliation
// helper (`src/reconcile/positions-vs-chain.mjs`). Every finding kind
// + every edge case the operator has hit (FEW pos_tlbiuvh6_0002
// sold-off-chain case; OLA/NWB category-case mismatch case; missing
// amounts; BCH-only UTXOs that should be ignored) gets its own
// fixture.
//
// Run with:
//   node --test tests/reconcile-positions-vs-chain.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  diffPositionsVsChain,
  normalizeTokenId,
  bucketUtxosByTokenCategory,
  positionAmountAsBigInt,
  RECONCILE_REPORT_VERSION,
  FINDING_KINDS,
} from '../src/reconcile/positions-vs-chain.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Constants / shape contracts
// ─────────────────────────────────────────────────────────────────────

test('reconcile: RECONCILE_REPORT_VERSION is 1', () => {
  assert.equal(RECONCILE_REPORT_VERSION, 1);
});

test('reconcile: FINDING_KINDS lists every supported finding kind', () => {
  assert.deepEqual([...FINDING_KINDS].sort(), [
    'consensus',
    'note',
    'on_chain_only',
    'on_disk_only',
    'quantity_mismatch',
  ]);
});

// ─────────────────────────────────────────────────────────────────────
//  normalizeTokenId
// ─────────────────────────────────────────────────────────────────────

test('reconcile: normalizeTokenId lowercases + trims 64-hex', () => {
  // 64-char lowercase hex (mixed case), wrapped in whitespace.
  const mixed = 'AbCdEf'.repeat(10) + 'aBcDeF'.repeat(1) + '0'.repeat(0) + 'a'.repeat(4); // 64 chars total
  const id = 'AbCdEf'.repeat(10) + 'aBcDeF' + '1234567890abcdef'.replace(/^.{4}/, 'abcd');
  // Easier: build deterministically.
  const raw = ('A'.repeat(2) + 'b'.repeat(2) + 'C'.repeat(2) + 'd'.repeat(2)).repeat(8); // 64 chars
  const expected = raw.toLowerCase();
  assert.equal(expected.length, 64);
  assert.equal(normalizeTokenId('  ' + raw + '  '), expected);
});

test('reconcile: normalizeTokenId rejects non-string / wrong length / non-hex', () => {
  assert.equal(normalizeTokenId(null), null);
  assert.equal(normalizeTokenId(undefined), null);
  assert.equal(normalizeTokenId(123), null);
  assert.equal(normalizeTokenId('a'.repeat(63)), null);     // 63 hex chars
  assert.equal(normalizeTokenId('a'.repeat(64) + 'X'), null); // trailing garbage
  assert.equal(normalizeTokenId('g'.repeat(64)), null);      // non-hex char
});

test('reconcile: normalizeTokenId idempotent on already-normalized', () => {
  const id = 'd9ab24ed15a7846cc3d9e004aa5cb976860f13dac1ead05784ee4f4622af96ea';
  assert.equal(normalizeTokenId(id), id);
});

// ─────────────────────────────────────────────────────────────────────
//  bucketUtxosByTokenCategory
// ─────────────────────────────────────────────────────────────────────

test('reconcile: bucketUtxosByTokenCategory sums fungible amounts per category', () => {
  const cat = 'a'.repeat(64);
  const utxos = [
    { txid: '1'.repeat(64), vout: 0, satoshis: 1000n, token: { category: cat, amount: 100n } },
    { txid: '2'.repeat(64), vout: 0, satoshis: 1000n, token: { category: cat.toUpperCase(), amount: 250n } },
    { txid: '3'.repeat(64), vout: 0, satoshis: 1000n, token: { category: cat, amount: 75n } },
    // BCH-only (no token) — should NOT contribute to perCategory.
    { txid: '4'.repeat(64), vout: 0, satoshis: 5000n },
  ];
  const r = bucketUtxosByTokenCategory(utxos);
  assert.equal(r.perCategory.get(cat), 425n);
  // 4 UTXOs total — all carry satoshis. Token UTXOs are also BCH
  // UTXOs (the standard cauldron output shape).
  assert.equal(r.bchUtxoCount, 4);
  assert.equal(r.bchBalanceSats, 8000n);
});

test('reconcile: bucketUtxosByTokenCategory tolerates non-array + number/string amounts', () => {
  const cat = 'b'.repeat(64);
  const utxos = [
    { txid: '1'.repeat(64), vout: 0, satoshis: 1000, token: { category: cat, amount: '500' } },
    { txid: '2'.repeat(64), vout: 0, satoshis: '2000', token: { category: cat, amount: 100n } },
  ];
  const r = bucketUtxosByTokenCategory(utxos);
  assert.equal(r.perCategory.get(cat), 600n);
  assert.equal(r.bchBalanceSats, 3000n);
});

test('reconcile: bucketUtxosByTokenCategory tolerates garbage UTXO entries', () => {
  const utxos = [null, undefined, 'not-an-object', 42, {}];
  const r = bucketUtxosByTokenCategory(utxos);
  assert.equal(r.perCategory.size, 0);
  assert.equal(r.bchBalanceSats, 0n);
  assert.equal(r.bchUtxoCount, 0);
});

test('reconcile: bucketUtxosByTokenCategory skips token entries with malformed category', () => {
  const utxos = [
    { txid: '1'.repeat(64), vout: 0, satoshis: 1000n, token: { category: 'short', amount: 100n } },
    { txid: '2'.repeat(64), vout: 0, satoshis: 1000n, token: { category: null, amount: 100n } },
  ];
  const r = bucketUtxosByTokenCategory(utxos);
  assert.equal(r.perCategory.size, 0);
  // Both should be bucketed as BCH-side because the category failed
  // the normalization check.
  assert.equal(r.bchUtxoCount, 2);
});

// ─────────────────────────────────────────────────────────────────────
//  positionAmountAsBigInt
// ─────────────────────────────────────────────────────────────────────

test('reconcile: positionAmountAsBigInt handles string/number/bigint', () => {
  assert.equal(positionAmountAsBigInt('1315'), 1315n);
  assert.equal(positionAmountAsBigInt(1315), 1315n);
  assert.equal(positionAmountAsBigInt(1315n), 1315n);
});

test('reconcile: positionAmountAsBigInt rejects garbage + non-integer floats', () => {
  assert.equal(positionAmountAsBigInt(null), null);
  assert.equal(positionAmountAsBigInt(''), null);
  assert.equal(positionAmountAsBigInt('   '), null);
  assert.equal(positionAmountAsBigInt('not-a-number'), null);
  assert.equal(positionAmountAsBigInt(1.5), null);
  assert.equal(positionAmountAsBigInt(NaN), null);
  assert.equal(positionAmountAsBigInt(Infinity), null);
  assert.equal(positionAmountAsBigInt({}), null);
});

// ─────────────────────────────────────────────────────────────────────
//  diffPositionsVsChain — empty / no-op cases
// ─────────────────────────────────────────────────────────────────────

test('reconcile: empty positions + empty utxos → low-severity notes (no high/medium)', () => {
  const report = diffPositionsVsChain([], []);
  assert.equal(report.summary.open_positions, 0);
  assert.equal(report.summary.on_chain_tokens, 0);
  assert.equal(report.summary.high, 0);
  assert.equal(report.summary.medium, 0);
  // Two low-severity notes: "no open positions" + "wallet holds 0 BCH".
  const notes = report.findings.filter((f) => f.kind === 'note');
  assert.equal(notes.length, 2);
  assert.ok(notes.some((n) => n.details.reason === 'no_open_positions'));
  assert.ok(notes.some((n) => n.details.reason === 'no_bch'));
});

test('reconcile: non-array positions / utxos → no crash, only low-severity notes', () => {
  const r1 = diffPositionsVsChain(null, null);
  assert.equal(r1.summary.high, 0);
  assert.equal(r1.summary.medium, 0);
  // Both notes still fire (no positions + 0 BCH).
  assert.ok(r1.summary.low >= 1);
  const r2 = diffPositionsVsChain(undefined, undefined);
  assert.equal(r2.summary.high, 0);
  assert.equal(r2.summary.medium, 0);
  const r3 = diffPositionsVsChain('not-array', 42);
  assert.equal(r3.summary.high, 0);
  assert.equal(r3.summary.medium, 0);
});

test('reconcile: respects opts.generatedAt for the report timestamp', () => {
  const ts = '2026-09-17T16:15:00.000Z';
  const r = diffPositionsVsChain([], [], { generatedAt: ts });
  assert.equal(r.generated_at, ts);
});

// ─────────────────────────────────────────────────────────────────────
//  diffPositionsVsChain — consensus
// ─────────────────────────────────────────────────────────────────────

test('reconcile: consensus findings for every matching position', () => {
  const cat = 'c'.repeat(64);
  const positions = [
    { id: 'pos_a', status: 'open', token_id: cat, token_symbol: 'TKA',
      entry: { token_amount_base: '1315' } },
    { id: 'pos_b', status: 'open', token_id: 'd'.repeat(64), token_symbol: 'TKB',
      entry: { token_amount_base: '500' } },
  ];
  const utxos = [
    { txid: '1'.repeat(64), vout: 0, satoshis: 1000n, token: { category: cat, amount: 1315n } },
    { txid: '2'.repeat(64), vout: 0, satoshis: 1000n, token: { category: 'd'.repeat(64), amount: 500n } },
  ];
  const report = diffPositionsVsChain(positions, utxos, { generatedAt: '2026-09-17T16:15:00Z' });
  assert.equal(report.summary.open_positions, 2);
  assert.equal(report.summary.on_chain_tokens, 2);
  assert.equal(report.summary.high, 0);
  assert.equal(report.summary.medium, 0);
  // Two consensus findings; the no_bch note should NOT fire
  // (bchUtxoCount === 2 because each token UTXO carries satoshis).
  const consensus = report.findings.filter((f) => f.kind === 'consensus');
  assert.equal(consensus.length, 2);
  const noBch = report.findings.find((f) => f.kind === 'note' && f.details.reason === 'no_bch');
  assert.equal(noBch, undefined);
});

test('reconcile: case-mismatched token_category still produces consensus (normalizeTokenId)', () => {
  // Positions store lower-cases categories, Electrum returns upper.
  const catLower = 'e'.repeat(64);
  const catUpper = catLower.toUpperCase();
  const positions = [
    { id: 'pos_a', status: 'open', token_id: catLower, token_symbol: 'TKA',
      entry: { token_amount_base: '1315' } },
  ];
  const utxos = [
    { txid: '1'.repeat(64), vout: 0, satoshis: 1000n, token: { category: catUpper, amount: 1315n } },
  ];
  const report = diffPositionsVsChain(positions, utxos);
  const consensus = report.findings.filter((f) => f.kind === 'consensus');
  assert.equal(consensus.length, 1);
  assert.equal(report.summary.high, 0);
  assert.equal(report.summary.medium, 0);
});

// ─────────────────────────────────────────────────────────────────────
//  diffPositionsVsChain — on_disk_only (the FEW pos_tlbiuvh6_0002 case)
// ─────────────────────────────────────────────────────────────────────

test('reconcile: on_disk_only when position is open but wallet has 0 tokens', () => {
  const cat = 'f'.repeat(64);
  const positions = [
    { id: 'pos_few_0001', status: 'open', token_id: cat, token_symbol: 'FEW',
      entry: { token_amount_base: '507044', txid: 'ab'.repeat(32) } },
  ];
  // Wallet holds BCH but no tokens.
  const utxos = [{ txid: '1'.repeat(64), vout: 0, satoshis: 100000n }];
  const report = diffPositionsVsChain(positions, utxos, { generatedAt: '2026-09-17T16:15:00Z' });
  const findings = report.findings.filter((f) => f.kind !== 'note');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'on_disk_only');
  assert.equal(findings[0].severity, 'high');
  assert.equal(findings[0].position_id, 'pos_few_0001');
  assert.equal(findings[0].token_id, cat);
  assert.match(findings[0].summary, /pos_few_0001/);
  assert.match(findings[0].summary, /wallet holds 0 tokens/);
  assert.equal(findings[0].details.subtype, 'sold_off_chain');
  assert.match(findings[0].recommended_action, /reconcile-position\.mjs/);
});

test('reconcile: on_disk_only with malformed_amount when position missing token_amount_base', () => {
  const cat = 'a1'.repeat(32);
  const positions = [
    { id: 'pos_malformed_0001', status: 'open', token_id: cat, token_symbol: 'BAD',
      entry: { token_amount_base: null } },
  ];
  const utxos = [
    { txid: '1'.repeat(64), vout: 0, satoshis: 1000n, token: { category: cat, amount: 100n } },
  ];
  const report = diffPositionsVsChain(positions, utxos);
  const f = report.findings.find((x) => x.kind === 'on_disk_only');
  assert.ok(f, 'expected on_disk_only finding');
  assert.equal(f.details.subtype, 'malformed_amount');
  assert.equal(f.details.malformed_amount, true);
  assert.match(f.recommended_action, /inspect-position-record/);
});

test('reconcile: on_disk_only with malformed_token_id when token_id is not 64-hex', () => {
  const positions = [
    { id: 'pos_badtok_0001', status: 'open', token_id: 'not-a-real-token-id',
      token_symbol: 'BAD', entry: { token_amount_base: '100' } },
  ];
  const report = diffPositionsVsChain(positions, []);
  const f = report.findings.find((x) => x.kind === 'on_disk_only');
  assert.ok(f, 'expected on_disk_only finding');
  assert.equal(f.details.reason, 'malformed_token_id');
  assert.equal(f.token_id, null);
  assert.match(f.recommended_action, /inspect-position-record/);
});

// ─────────────────────────────────────────────────────────────────────
//  diffPositionsVsChain — on_chain_only (wallet has untracked tokens)
// ─────────────────────────────────────────────────────────────────────

test('reconcile: on_chain_only when wallet has tokens but no position tracks them', () => {
  const catA = 'a2'.repeat(32);
  const catB = 'b2'.repeat(32);
  const positions = [
    { id: 'pos_a', status: 'open', token_id: catA, token_symbol: 'TKA',
      entry: { token_amount_base: '100' } },
  ];
  const utxos = [
    { txid: '1'.repeat(64), vout: 0, satoshis: 1000n, token: { category: catA, amount: 100n } },
    { txid: '2'.repeat(64), vout: 0, satoshis: 1000n, token: { category: catB, amount: 7500n } },
  ];
  const report = diffPositionsVsChain(positions, utxos);
  // 1 consensus for TKA + 1 on_chain_only for TKB.
  const consensus = report.findings.filter((f) => f.kind === 'consensus');
  const untracked = report.findings.filter((f) => f.kind === 'on_chain_only');
  assert.equal(consensus.length, 1);
  assert.equal(untracked.length, 1);
  assert.equal(untracked[0].severity, 'medium');
  assert.equal(untracked[0].token_id, catB);
  assert.equal(untracked[0].details.subtype, 'untracked_tokens');
  assert.match(untracked[0].recommended_action, /sync-wallet-holdings\.mjs/);
});

// ─────────────────────────────────────────────────────────────────────
//  diffPositionsVsChain — quantity_mismatch
// ─────────────────────────────────────────────────────────────────────

test('reconcile: quantity_mismatch when position claims X but wallet holds Y != X', () => {
  const cat = 'a3'.repeat(32);
  const positions = [
    { id: 'pos_partial', status: 'open', token_id: cat, token_symbol: 'PART',
      entry: { token_amount_base: '1000' } },
  ];
  // Wallet holds 250 (partial sweep / dust).
  const utxos = [
    { txid: '1'.repeat(64), vout: 0, satoshis: 1000n, token: { category: cat, amount: 250n } },
  ];
  const report = diffPositionsVsChain(positions, utxos);
  const f = report.findings.find((x) => x.kind === 'quantity_mismatch');
  assert.ok(f, 'expected quantity_mismatch finding');
  assert.equal(f.severity, 'medium');
  assert.equal(f.details.expected_token_amount_base, '1000');
  assert.equal(f.details.wallet_token_amount_base, '250');
  // ratio = 250/1000 = 0.25 → "25.0% of expected"
  assert.match(f.summary, /25\.0%/);
});

test('reconcile: wallet holds MORE than position (over-fill case) is also quantity_mismatch', () => {
  const cat = 'a4'.repeat(32);
  const positions = [
    { id: 'pos_over', status: 'open', token_id: cat, token_symbol: 'OVER',
      entry: { token_amount_base: '100' } },
  ];
  const utxos = [
    { txid: '1'.repeat(64), vout: 0, satoshis: 1000n, token: { category: cat, amount: 175n } },
  ];
  const report = diffPositionsVsChain(positions, utxos);
  const f = report.findings.find((x) => x.kind === 'quantity_mismatch');
  assert.ok(f);
  assert.match(f.summary, /175\.0%/);
});

// ─────────────────────────────────────────────────────────────────────
//  diffPositionsVsChain — status filter (only `open` is compared)
// ─────────────────────────────────────────────────────────────────────

test('reconcile: pending / closing positions are NOT compared (mid-flight noise)', () => {
  const cat = 'a5'.repeat(32);
  const positions = [
    { id: 'pos_pending', status: 'pending', token_id: cat, token_symbol: 'PND',
      entry: { token_amount_base: '100' } },
    { id: 'pos_closing', status: 'closing', token_id: cat, token_symbol: 'CLS',
      entry: { token_amount_base: '100' } },
  ];
  // Wallet has no matching tokens — but neither position is `open`,
  // so no on_disk_only finding should be emitted.
  const report = diffPositionsVsChain(positions, []);
  assert.equal(report.summary.open_positions, 0);
  // Only the two notes ("no open positions" + "no_bch") fire.
  const onDiskOnly = report.findings.filter((f) => f.kind === 'on_disk_only');
  assert.equal(onDiskOnly.length, 0);
  const notes = report.findings.filter((f) => f.kind === 'note');
  assert.ok(notes.some((n) => n.details.reason === 'no_open_positions'));
});

// ─────────────────────────────────────────────────────────────────────
//  diffPositionsVsChain — notes
// ─────────────────────────────────────────────────────────────────────

test('reconcile: empty wallet + open positions adds a "no_token_utxos" note', () => {
  const cat = 'a6'.repeat(32);
  const positions = [
    { id: 'pos_x', status: 'open', token_id: cat, token_symbol: 'X',
      entry: { token_amount_base: '100' } },
  ];
  // No utxos at all.
  const report = diffPositionsVsChain(positions, []);
  // Expect: 1 on_disk_only + 1 "no_token_utxos" note + 1 "no_bch" note.
  const notes = report.findings.filter((f) => f.kind === 'note');
  assert.equal(notes.length, 2);
  assert.ok(notes.some((n) => n.details.reason === 'no_token_utxos'));
  assert.ok(notes.some((n) => n.details.reason === 'no_bch'));
});

test('reconcile: zero BCH balance emits a low-severity note', () => {
  // Empty utxos → 0 BCH.
  const report = diffPositionsVsChain([], []);
  const noBch = report.findings.find((f) => f.kind === 'note' && f.details.reason === 'no_bch');
  assert.ok(noBch);
  assert.equal(noBch.severity, 'low');
  assert.equal(noBch.details.bch_balance_sats, '0');
});

// ─────────────────────────────────────────────────────────────────────
//  diffPositionsVsChain — legacy multi-position same-category
// ─────────────────────────────────────────────────────────────────────

test('reconcile: legacy duplicate positions for same category produce per-position findings', () => {
  const cat = 'a7'.repeat(32);
  const positions = [
    // Two legacy positions for the same token; each claims 200 base units.
    // The wallet holds 100 base units. Each position gets a
    // quantity_mismatch at 50% of expected (100/200).
    { id: 'pos_old', status: 'open', token_id: cat, token_symbol: 'DUP',
      entry: { token_amount_base: '200' } },
    { id: 'pos_new', status: 'open', token_id: cat, token_symbol: 'DUP',
      entry: { token_amount_base: '200' } },
  ];
  const utxos = [
    { txid: '1'.repeat(64), vout: 0, satoshis: 1000n, token: { category: cat, amount: 100n } },
  ];
  const report = diffPositionsVsChain(positions, utxos);
  const mismatches = report.findings.filter((f) => f.kind === 'quantity_mismatch');
  assert.equal(mismatches.length, 2);
  assert.deepEqual(mismatches.map((m) => m.position_id).sort(), ['pos_new', 'pos_old']);
  for (const m of mismatches) {
    assert.equal(m.severity, 'medium');
    assert.match(m.summary, /50\.0%/);
  }
});

// ─────────────────────────────────────────────────────────────────────
//  diffPositionsVsChain — schema version + summary shape
// ─────────────────────────────────────────────────────────────────────

test('reconcile: report envelope shape (version + summary fields)', () => {
  const report = diffPositionsVsChain([], [], { generatedAt: '2026-09-17T16:15:00Z' });
  assert.equal(report.version, RECONCILE_REPORT_VERSION);
  assert.equal(typeof report.generated_at, 'string');
  assert.equal(report.generated_at, '2026-09-17T16:15:00Z');
  // summary has every counter the endpoint exposes.
  for (const k of ['open_positions', 'on_chain_tokens', 'findings', 'high', 'medium', 'low']) {
    assert.equal(typeof report.summary[k], 'number', `summary.${k} should be a number`);
  }
});

test('reconcile: report.generated_at is null when caller omits opts.generatedAt (helper stays pure)', () => {
  const report = diffPositionsVsChain([], []);
  assert.equal(report.generated_at, null);
});

test('reconcile: every finding has kind + severity + summary', () => {
  const cat = 'a8'.repeat(32);
  const positions = [
    { id: 'pos_y', status: 'open', token_id: cat, token_symbol: 'Y',
      entry: { token_amount_base: '100' } },
  ];
  const utxos = [
    { txid: '1'.repeat(64), vout: 0, satoshis: 1000n, token: { category: cat, amount: 100n } },
  ];
  const report = diffPositionsVsChain(positions, utxos);
  for (const f of report.findings) {
    assert.ok(FINDING_KINDS.includes(f.kind), `unknown finding kind ${f.kind}`);
    assert.ok(['low', 'medium', 'high'].includes(f.severity), `unknown severity ${f.severity}`);
    assert.equal(typeof f.summary, 'string');
    assert.ok(f.summary.length > 0);
  }
});
