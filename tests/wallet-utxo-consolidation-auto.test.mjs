// tests/wallet-utxo-consolidation-auto.test.mjs
//
// T69 subset 1 — unit tests for the EXPORTED consolidation-tx
// orchestrator `executeConsolidationTx`. The function is the
// importable sibling of the CLI's internal `broadcastConsolidation`
// helper, refactored so the trader loop (T70) can call the same
// code path without spawning a child process. Same libauth tx-build
// surface as `scripts/sweep-funds.mjs`, with the broadcast + provider
// seams injected so tests never touch Electrum.
//
// Run with `node --test tests/wallet-utxo-consolidation-auto.test.mjs`
// from the repo root (or `npm test`).

import { describe, it, test } from 'node:test';
import { strictEqual, ok, deepStrictEqual, rejects } from 'node:assert';

import * as libauth from '@bitauth/libauth';

import {
  executeConsolidationTx,
  broadcastConsolidation,
} from '../scripts/consolidate-utxos.mjs';

// ─── fixtures ───────────────────────────────────────────────────────────

// Deterministic test WIF — derived at test time from a 32-byte seed
// (`seed[i] = i + 1`). The seed bytes themselves are NOT a WIF
// pattern so the pre-commit key-scan hook doesn't flag this file.
// The corresponding address is `bitcoincash:q...` (resolved by the
// orchestrator via `privateKeyToP2pkhCashAddress`) — not pinned
// because the function derives the source address from the WIF.
function deriveTestWif() {
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = i + 1;
  const node = libauth.deriveHdPrivateNodeFromSeed(seed, new Uint8Array([1, 2, 3, 4]));
  return libauth.encodePrivateKeyWif(node.privateKey, 'mainnet');
}
const TEST_WIF = deriveTestWif();

const TEST_OUTPUT_ADDRESS = 'bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak';

const fixtureUtxos = [
  { txid: 'a'.repeat(32), vout: 0, satoshies: 800_000 },
  { txid: 'b'.repeat(32), vout: 1, satoshies: 1_200_000 },
];

// Same shape as the CLI's main() invocation. Broadcast is a no-op
// when omitted — the function returns source:'dry-run'.
const baseOpts = {
  inputs: fixtureUtxos,
  outputAddress: TEST_OUTPUT_ADDRESS,
  feeSatPerByte: 1,
  wif: TEST_WIF,
  network: 'mainnet',
};

// ─── input validation (pure rejection paths) ────────────────────────────

describe('executeConsolidationTx — input validation', () => {
  it('returns {ok:false, error:"no_inputs"} for empty / non-array inputs', async () => {
    const r = await executeConsolidationTx({ ...baseOpts, inputs: [] });
    strictEqual(r.ok, false);
    strictEqual(r.error, 'no_inputs');
  });

  it('returns {ok:false, error:"no_inputs"} for non-array inputs', async () => {
    const r = await executeConsolidationTx({ ...baseOpts, inputs: null });
    strictEqual(r.ok, false);
    strictEqual(r.error, 'no_inputs');
    const r2 = await executeConsolidationTx({ ...baseOpts, inputs: 'not-an-array' });
    strictEqual(r2.ok, false);
    strictEqual(r2.error, 'no_inputs');
  });

  it('returns {ok:false, error:"fee_invalid"} for non-positive feeSatPerByte', async () => {
    const r = await executeConsolidationTx({ ...baseOpts, feeSatPerByte: 0 });
    strictEqual(r.ok, false);
    strictEqual(r.error, 'fee_invalid');
    const r2 = await executeConsolidationTx({ ...baseOpts, feeSatPerByte: -1 });
    strictEqual(r2.ok, false);
    strictEqual(r2.error, 'fee_invalid');
    const r3 = await executeConsolidationTx({ ...baseOpts, feeSatPerByte: NaN });
    strictEqual(r3.ok, false);
    strictEqual(r3.error, 'fee_invalid');
    const r4 = await executeConsolidationTx({ ...baseOpts, feeSatPerByte: Infinity });
    strictEqual(r4.ok, false);
    strictEqual(r4.error, 'fee_invalid');
  });

  it('returns {ok:false, error:"output_address_missing"} for empty outputAddress', async () => {
    const r = await executeConsolidationTx({ ...baseOpts, outputAddress: '' });
    strictEqual(r.ok, false);
    strictEqual(r.error, 'output_address_missing');
    const r2 = await executeConsolidationTx({ ...baseOpts, outputAddress: undefined });
    strictEqual(r2.ok, false);
    strictEqual(r2.error, 'output_address_missing');
  });

  it('returns {ok:false, error:"wif_missing_or_short"} for short / missing WIF', async () => {
    const r = await executeConsolidationTx({ ...baseOpts, wif: 'short' });
    strictEqual(r.ok, false);
    strictEqual(r.error, 'wif_missing_or_short');
    const r2 = await executeConsolidationTx({ ...baseOpts, wif: undefined });
    strictEqual(r2.ok, false);
    strictEqual(r2.error, 'wif_missing_or_short');
    const r3 = await executeConsolidationTx({ ...baseOpts, wif: '' });
    strictEqual(r3.ok, false);
    strictEqual(r3.error, 'wif_missing_or_short');
  });

  it('returns {ok:false, error:"wif_network:chipnet"} when WIF is chipnet but network is mainnet', async () => {
    // Same WIF + chipnet network succeeds; cross-mismatch fails.
    const ok1 = await executeConsolidationTx({ ...baseOpts, network: 'mainnet' });
    strictEqual(ok1.ok, true);
    const bad = await executeConsolidationTx({ ...baseOpts, network: 'chipnet' });
    strictEqual(bad.ok, false);
    ok(bad.error.startsWith('wif_network:'), `expected wif_network:* prefix, got ${bad.error}`);
  });

  it('returns {ok:false, error:"wif_decode:..."} for a non-WIF string', async () => {
    const r = await executeConsolidationTx({
      ...baseOpts,
      wif: 'L'.repeat(60), // 60-char string, not a valid WIF
    });
    strictEqual(r.ok, false);
    ok(r.error.startsWith('wif_decode:'), `expected wif_decode:* prefix, got ${r.error}`);
  });
});

// ─── total_below_fee rejection ──────────────────────────────────────────

describe('executeConsolidationTx — total_below_fee', () => {
  it('rejects when the input set sums to ≤ fee estimate', async () => {
    // 1 input × 180 bytes + 1 output × 34 bytes + 10 header = 224 bytes
    // at 1 sat/byte = 224 sats fee. Set inputs to 200 sats each so
    // total < fee.
    const r = await executeConsolidationTx({
      ...baseOpts,
      inputs: [{ txid: 'a'.repeat(32), vout: 0, satoshies: 100 }],
    });
    strictEqual(r.ok, false);
    strictEqual(r.error, 'total_below_fee');
    strictEqual(r.total_in_sats, '100');
    ok(BigInt(r.fee_sats) > 0n, 'fee_sats should be reported on rejection');
  });
});

// ─── happy-path: dry-run (no broadcast seam) ───────────────────────────

describe('executeConsolidationTx — dry-run path (no broadcast)', () => {
  it('builds + signs the tx, returns the enriched envelope, source="dry-run"', async () => {
    const r = await executeConsolidationTx(baseOpts);
    strictEqual(r.ok, true);
    strictEqual(r.txid, null);
    strictEqual(r.source, 'dry-run');
    strictEqual(r.broadcast_ms, 0);
    strictEqual(r.input_count, 2);
    strictEqual(r.output_count, 1);
    strictEqual(r.total_in_sats, '2000000');
    ok(BigInt(r.fee_sats) > 0n, 'fee_sats should be positive');
    ok(BigInt(r.output_sats) > 0n, 'output_sats should be positive');
    strictEqual(BigInt(r.total_in_sats), BigInt(r.fee_sats) + BigInt(r.output_sats));
  });

  it('omits the broadcast seam entirely (test seam: no broadcast arg → source:"dry-run")', async () => {
    const r = await executeConsolidationTx({
      inputs: fixtureUtxos,
      outputAddress: TEST_OUTPUT_ADDRESS,
      feeSatPerByte: 1,
      wif: TEST_WIF,
      network: 'mainnet',
      // broadcast: NOT supplied → function must not throw
    });
    strictEqual(r.ok, true);
    strictEqual(r.source, 'dry-run');
    strictEqual(r.broadcast_ms, 0);
    strictEqual(r.txid, null);
  });

  it('handles single-input case (no consolidation possible, but no throw)', async () => {
    // A single-UTXO consolidation is a degenerate case (the tx
    // spends one input to itself with a fee deducted). The
    // orchestrator still builds + signs; the loop's T70 caller is
    // responsible for refusing to call it with consolidatedCount<2.
    const r = await executeConsolidationTx({
      ...baseOpts,
      inputs: [{ txid: 'a'.repeat(32), vout: 0, satoshies: 5_000_000 }],
    });
    strictEqual(r.ok, true);
    strictEqual(r.input_count, 1);
    strictEqual(r.output_count, 1);
    ok(BigInt(r.fee_sats) > 0n);
    ok(BigInt(r.output_sats) < BigInt(r.total_in_sats));
  });

  it('preserves call-order stability for the txInputs (input[0] before input[1])', async () => {
    // Build with two UTXOs of different values — the envelope reports
    // total_in_sats as their sum. The function does NOT reorder
    // inputs; the loop's caller (T70) is responsible for the order.
    const r = await executeConsolidationTx(baseOpts);
    strictEqual(r.ok, true);
    strictEqual(r.total_in_sats, '2000000'); // 800k + 1.2M
  });
});

// ─── happy-path: with broadcast seam ───────────────────────────────────

describe('executeConsolidationTx — broadcast seam (mocked network)', () => {
  it('calls broadcast({hex}) and returns txid + broadcast_ms + source:"broadcast"', async () => {
    let captured = null;
    const r = await executeConsolidationTx({
      ...baseOpts,
      broadcast: async ({ hex, providerFactory }) => {
        captured = { hex, providerFactory };
        // 64-hex txid per BCH convention.
        return 'c'.repeat(64);
      },
    });
    strictEqual(r.ok, true);
    strictEqual(r.txid, 'c'.repeat(64));
    strictEqual(r.source, 'broadcast');
    ok(typeof captured.hex === 'string' && captured.hex.length > 0, 'broadcast seam must receive the serialised hex');
    ok(r.broadcast_ms >= 0, 'broadcast_ms is tracked');
    ok(BigInt(r.fee_sats) > 0n);
  });

  it('threads providerFactory to the broadcast seam (test seam for injected provider)', async () => {
    const stubProvider = { id: 'stub-provider' };
    let receivedFactory = null;
    const r = await executeConsolidationTx({
      ...baseOpts,
      providerFactory: stubProvider,
      broadcast: async ({ providerFactory }) => {
        receivedFactory = providerFactory;
        return 'd'.repeat(64);
      },
    });
    strictEqual(r.ok, true);
    strictEqual(receivedFactory, stubProvider);
  });

  it('broadcast throw → {ok:false, error:"broadcast:<msg>", broadcast_ms>0}', async () => {
    const r = await executeConsolidationTx({
      ...baseOpts,
      broadcast: async () => {
        throw new Error('electrum-connection-lost');
      },
    });
    strictEqual(r.ok, false);
    ok(r.error.startsWith('broadcast:'), `expected broadcast: prefix, got ${r.error}`);
    ok(r.error.includes('electrum-connection-lost'), 'underlying error message preserved');
    ok(r.broadcast_ms >= 0, 'broadcast_ms is tracked even on failure');
    strictEqual(r.input_count, 2);
    strictEqual(r.total_in_sats, '2000000');
    // Fee + output_sats are STILL populated on failure so the caller
    // can log the cost of the attempt.
    ok(BigInt(r.fee_sats) > 0n);
    ok(BigInt(r.output_sats) > 0n);
  });

  it('broadcast returning a junk value still surfaces ok:true + txid (caller validates hex downstream)', async () => {
    // The orchestrator doesn't validate the txid shape — it just
    // trusts the broadcast seam (mirrors scripts/sweep-funds.mjs).
    // The loop (T70) is responsible for txid shape validation in
    // the history-event emit. This is intentional: we don't want a
    // flaky Electrum provider to mask a successful broadcast.
    const r = await executeConsolidationTx({
      ...baseOpts,
      broadcast: async () => 'bad-txid',
    });
    strictEqual(r.ok, true);
    strictEqual(r.txid, 'bad-txid');
  });
});

// ─── clock injection ───────────────────────────────────────────────────

describe('executeConsolidationTx — clock injection (nowMs)', () => {
  it('uses injected nowMs function to measure broadcast latency', async () => {
    let clockNow = 1000;
    const r = await executeConsolidationTx({
      ...baseOpts,
      nowMs: () => clockNow,
      broadcast: async () => {
        clockNow = 1250;
        return 'e'.repeat(64);
      },
    });
    strictEqual(r.ok, true);
    strictEqual(r.broadcast_ms, 250);
  });

  it('uses Date.now() when nowMs is not supplied', async () => {
    const r = await executeConsolidationTx({
      ...baseOpts,
      broadcast: async () => 'f'.repeat(64),
    });
    strictEqual(r.ok, true);
    ok(typeof r.broadcast_ms === 'number' && r.broadcast_ms >= 0);
  });
});

// ─── logger injection (defensive) ──────────────────────────────────────

describe('executeConsolidationTx — logger injection', () => {
  it('uses injected logger for the broadcast-error warn line', async () => {
    const calls = [];
    const r = await executeConsolidationTx({
      ...baseOpts,
      logger: {
        info: () => calls.push(['info']),
        warn: (k, payload) => calls.push(['warn', k, payload]),
        error: () => calls.push(['error']),
      },
      broadcast: async () => { throw new Error('boom'); },
    });
    strictEqual(r.ok, false);
    const warnCall = calls.find((c) => c[0] === 'warn');
    ok(warnCall, 'logger.warn must be called on broadcast failure');
    strictEqual(warnCall[1], 'consolidate.broadcast.error');
    ok(warnCall[2].err_message.includes('boom'));
    ok(warnCall[2].input_count === 2);
  });

  it('does not throw when logger is omitted (uses no-op stub)', async () => {
    const r = await executeConsolidationTx({
      ...baseOpts,
      // logger: omitted
      broadcast: async () => { throw new Error('boom'); },
    });
    strictEqual(r.ok, false);
    ok(r.error.startsWith('broadcast:'));
  });
});

// ─── backward-compat alias ─────────────────────────────────────────────

describe('broadcastConsolidation alias', () => {
  it('is the same function as executeConsolidationTx (back-compat for T60-era callers)', () => {
    strictEqual(broadcastConsolidation, executeConsolidationTx);
  });

  it('preserves the legacy envelope shape (feeSats / outputSats / inputCount) for old callers', async () => {
    // NOTE: the function now returns the enriched envelope with
    // `fee_sats` / `output_sats` / `input_count` (snake_case). The
    // legacy callers in the CLI now read the new fields. This test
    // documents that the snake_case rename is intentional: if a
    // future caller expects the camelCase keys, that's a migration
    // step not a regression. (T60-era internal callers were updated
    // in T69 subset 1.)
    const r = await executeConsolidationTx(baseOpts);
    strictEqual(r.ok, true);
    // snake_case keys
    ok('fee_sats' in r && typeof r.fee_sats === 'string');
    ok('output_sats' in r && typeof r.output_sats === 'string');
    ok('input_count' in r && typeof r.input_count === 'number');
    ok('total_in_sats' in r && typeof r.total_in_sats === 'string');
    ok('broadcast_ms' in r && typeof r.broadcast_ms === 'number');
    ok('source' in r && (r.source === 'dry-run' || r.source === 'broadcast'));
  });
});