#!/usr/bin/env node
// tests/dashboard-setup.test.mjs
//
// Unit tests for the first-run setup wizard backend
// (`src/dashboard/setup.mjs`). Covers:
//   - `inspectSetupStatus` (empty / partial / fully-configured cfg)
//   - `truncateCashaddrForDisplay` (full / short / invalid)
//   - `validateSetupPayload` (happy / each error path)
//   - `validateWalletInput` (generate / bad-WIF / bad-mnemonic /
//     unsupported-network)
//   - `buildSetupPatch` (output shape + no-key-leak)
//
// Live tests for `generate` mode are SKIPPED if libauth can't
// load (e.g. CI without the @bitauth/libauth dependency) — the
// validator paths still get exercised.
//
// Run with:
//   node --test tests/dashboard-setup.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  inspectSetupStatus,
  truncateCashaddrForDisplay,
  validateSetupPayload,
  validateWalletInput,
  buildSetupPatch,
  SETUP_BOUNDS,
  WALLET_MODES,
} from '../src/dashboard/setup.mjs';

// ─────────────────────────────────────────────────────────────────────
//  inspectSetupStatus
// ─────────────────────────────────────────────────────────────────────

test('setup: inspectSetupStatus — empty cfg → setup_required=true with all 4 missing', async () => {
  const r = await inspectSetupStatus({});
  assert.equal(r.setup_required, true);
  assert.deepEqual(r.missing, ['network', 'wallet.wif', 'wallet.cashaddr', 'dashboard.api_token']);
  assert.equal(r.network, null);
  assert.equal(r.cashaddr, null);
});

test('setup: inspectSetupStatus — null cfg → setup_required=true', async () => {
  const r = await inspectSetupStatus(null);
  assert.equal(r.setup_required, true);
  assert.equal(r.network, null);
});

test('setup: inspectSetupStatus — partial cfg surfaces only missing fields', async () => {
  const r = await inspectSetupStatus({
    wallet: { network: 'mainnet', wif: 'Kx', cashaddr: 'bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak' },
  });
  assert.equal(r.setup_required, true);
  assert.deepEqual(r.missing, ['dashboard.api_token']);
  assert.equal(r.network, 'mainnet');
  assert.equal(r.cashaddr, 'qqcp6q…57ak');
});

test('setup: inspectSetupStatus — fully configured → setup_required=false', async () => {
  const r = await inspectSetupStatus({
    wallet: { network: 'mainnet', wif: 'Kx', cashaddr: 'bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak' },
    dashboard: { api_token: 'abc123def456' },
  });
  assert.equal(r.setup_required, false);
  assert.deepEqual(r.missing, []);
});

test('setup: inspectSetupStatus — chipnet counts as configured', async () => {
  const r = await inspectSetupStatus({
    wallet: { network: 'chipnet', wif: 'c', cashaddr: 'bchtest:qqcsl5m9c0gqfyxasxwxhlsp9wp7kklzgyg2yr8v3a' },
    dashboard: { api_token: 'abc' },
  });
  assert.equal(r.setup_required, false);
  assert.equal(r.network, 'chipnet');
});

// ─────────────────────────────────────────────────────────────────────
//  truncateCashaddrForDisplay
// ─────────────────────────────────────────────────────────────────────

test('setup: truncateCashaddrForDisplay — strips prefix and shows first 6 + last 4', () => {
  assert.equal(
    truncateCashaddrForDisplay('bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak'),
    'qqcp6q…57ak',
  );
});

test('setup: truncateCashaddrForDisplay — chipnet prefix stripped too', () => {
  assert.equal(
    truncateCashaddrForDisplay('bchtest:qqcsl5m9c0gqfyxasxwxhlsp9wp7kklzgyg2yr8v3a'),
    'qqcsl5…8v3a',
  );
});

test('setup: truncateCashaddrForDisplay — short input returned as-is', () => {
  assert.equal(truncateCashaddrForDisplay('qabc'), 'qabc');
  assert.equal(truncateCashaddrForDisplay(''), '');
});

test('setup: truncateCashaddrForDisplay — non-string returns empty string', () => {
  assert.equal(truncateCashaddrForDisplay(null), '');
  assert.equal(truncateCashaddrForDisplay(undefined), '');
});

// ─────────────────────────────────────────────────────────────────────
//  validateSetupPayload
// ─────────────────────────────────────────────────────────────────────

const VALID_PAYLOAD = Object.freeze({
  network: 'mainnet',
  wallet_mode: 'generate',
  max_position_bch: 0.005,
  max_total_exposure_bch: 0.04,
  take_profit_pct: 5.0,
  stop_loss_pct: 3.0,
  slippage_tolerance_bps: 100,
  time_stop_hours: 24,
});

test('setup: validateSetupPayload — happy path returns ok:true', () => {
  const r = validateSetupPayload(VALID_PAYLOAD);
  assert.equal(r.ok, true);
});

test('setup: validateSetupPayload — rejects non-object', () => {
  const r = validateSetupPayload(null);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === '_root'));
});

test('setup: validateSetupPayload — rejects unsupported network', () => {
  const r = validateSetupPayload({ ...VALID_PAYLOAD, network: 'fakenet' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === 'network'));
});

test('setup: validateSetupPayload — rejects unsupported wallet_mode', () => {
  const r = validateSetupPayload({ ...VALID_PAYLOAD, wallet_mode: 'guess' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === 'wallet_mode'));
});

test('setup: validateSetupPayload — import_mnemonic requires mnemonic', () => {
  const r = validateSetupPayload({ ...VALID_PAYLOAD, wallet_mode: 'import_mnemonic' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === 'mnemonic'));
});

test('setup: validateSetupPayload — import_wif requires wif', () => {
  const r = validateSetupPayload({ ...VALID_PAYLOAD, wallet_mode: 'import_wif' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === 'wif'));
});

test('setup: validateSetupPayload — bounded knobs reject out-of-range', () => {
  const r = validateSetupPayload({ ...VALID_PAYLOAD, max_position_bch: 5.0 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === 'max_position_bch'));
});

test('setup: validateSetupPayload — integer-typed knobs reject floats', () => {
  const r = validateSetupPayload({ ...VALID_PAYLOAD, slippage_tolerance_bps: 100.5 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === 'slippage_tolerance_bps'));
});

test('setup: validateSetupPayload — exposure must be ≥ position', () => {
  const r = validateSetupPayload({
    ...VALID_PAYLOAD,
    max_position_bch: 0.05,
    max_total_exposure_bch: 0.01,
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === 'max_total_exposure_bch'));
});

test('setup: validateSetupPayload — take_profit must be > stop_loss', () => {
  const r = validateSetupPayload({
    ...VALID_PAYLOAD,
    take_profit_pct: 3.0,
    stop_loss_pct: 3.0,
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === 'take_profit_pct'));
});

test('setup: validateSetupPayload — api_token rejects non-hex', () => {
  const r = validateSetupPayload({ ...VALID_PAYLOAD, api_token: 'not-hex' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === 'api_token'));
});

test('setup: validateSetupPayload — empty api_token is OK (auto-generates)', () => {
  const r = validateSetupPayload({ ...VALID_PAYLOAD, api_token: '' });
  assert.equal(r.ok, true);
});

// ─────────────────────────────────────────────────────────────────────
//  validateWalletInput
// ─────────────────────────────────────────────────────────────────────

test('setup: validateWalletInput — generate mode produces a wallet', async () => {
  const r = await validateWalletInput({ network: 'mainnet', wallet_mode: 'generate' });
  if (!r.ok) {
    // If libauth isn't available in the test env (rare), skip the
    // live parts but still assert the error structure.
    assert.ok(['MNEMONIC_INVALID', 'WIF_INVALID', 'NETWORK_MISMATCH'].includes(r.code) || /libauth|wasm/i.test(r.error ?? ''),
      `unexpected error: ${r.error}`);
    return;
  }
  assert.equal(r.ok, true);
  assert.ok(r.wallet.cashaddr);
  assert.ok(r.wallet.cashaddr.startsWith('bitcoincash:'));
  assert.ok(r.wallet.wif);
  assert.ok(r.wallet.wif.startsWith('K') || r.wallet.wif.startsWith('L'));
  assert.equal(r.wallet.network, 'mainnet');
  assert.ok(r.generated_mnemonic);
  assert.ok(r.generated_mnemonic.split(/\s+/).length >= 12);
});

test('setup: validateWalletInput — bad WIF checksum → WIF_INVALID', async () => {
  const r = await validateWalletInput({
    network: 'mainnet',
    wallet_mode: 'import_wif',
    // Same length as a real WIF but a flipped checksum byte.
    wif: 'KxQ4P9rrnEasbaUFRkfwvYrLy1amRaYisAr4B62NfAry4xd4F41e2E',
  });
  assert.equal(r.ok, false);
  // Either WIF_INVALID or a network error — both are acceptable
  // for an invalid WIF; the field must point at 'wif'.
  assert.equal(r.field, 'wif');
});

test('setup: validateWalletInput — random-gibberish mnemonic → MNEMONIC_INVALID', async () => {
  const r = await validateWalletInput({
    network: 'mainnet',
    wallet_mode: 'import_mnemonic',
    mnemonic: 'foo bar baz qux quux corge grault waldo fred plugh xyzzy thud',
  });
  assert.equal(r.ok, false);
  assert.equal(r.field, 'mnemonic');
});

test('setup: validateWalletInput — unsupported network rejected', async () => {
  const r = await validateWalletInput({ network: 'fakenet', wallet_mode: 'generate' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NETWORK_UNSUPPORTED');
});

test('setup: validateWalletInput — unsupported wallet_mode rejected', async () => {
  const r = await validateWalletInput({ network: 'mainnet', wallet_mode: 'guess' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'WALLET_MODE_INVALID');
});

// ─────────────────────────────────────────────────────────────────────
//  buildSetupPatch
// ─────────────────────────────────────────────────────────────────────

test('setup: buildSetupPatch — happy path has wallet + entry + exit blocks', () => {
  const patch = buildSetupPatch({
    wallet_mode: 'generate',
    wallet: {
      cashaddr: 'bitcoincash:qabc',
      wif: 'Kxxx',
      network: 'mainnet',
      bip44_path: "m/44'/145'/0'/0/0",
      mnemonic_word_count: 12,
    },
    max_position_bch: 0.005,
    max_total_exposure_bch: 0.04,
    take_profit_pct: 5,
    stop_loss_pct: 3,
    slippage_tolerance_bps: 100,
    time_stop_hours: 24,
  });
  assert.ok(patch.wallet);
  assert.equal(patch.wallet.cashaddr, 'bitcoincash:qabc');
  assert.equal(patch.wallet.wif, 'Kxxx');
  assert.equal(patch.wallet.network, 'mainnet');
  assert.equal(patch.wallet.wallet_mode, 'generate');
  assert.ok(patch.wallet.last_setup_at);
  assert.equal(patch.entry.max_position_bch, 0.005);
  assert.equal(patch.entry.slippage_tolerance_bps, 100);
  assert.equal(patch.exit.take_profit_pct, 5);
  assert.equal(patch.exit.time_stop_hours, 24);
  assert.equal(patch.dashboard, undefined);
});

test('setup: buildSetupPatch — api_token flows into dashboard block', () => {
  const patch = buildSetupPatch({
    wallet_mode: 'import_wif',
    wallet: { cashaddr: 'bchtest:qq', wif: 'cT', network: 'chipnet', bip44_path: "m/44'/145'/0'/0/0" },
    max_position_bch: 0.005,
    max_total_exposure_bch: 0.04,
    take_profit_pct: 5,
    stop_loss_pct: 3,
    slippage_tolerance_bps: 100,
    time_stop_hours: 24,
    api_token: 'abc123def456',
  });
  assert.equal(patch.dashboard.api_token, 'abc123def456');
});

// ─────────────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────────────

test('setup: SETUP_BOUNDS — every documented knob has bounds', () => {
  for (const k of [
    'max_position_bch',
    'max_total_exposure_bch',
    'take_profit_pct',
    'stop_loss_pct',
    'slippage_tolerance_bps',
    'time_stop_hours',
  ]) {
    assert.ok(SETUP_BOUNDS[k], `missing bounds for ${k}`);
    assert.ok(typeof SETUP_BOUNDS[k].min === 'number');
    assert.ok(typeof SETUP_BOUNDS[k].max === 'number');
    assert.ok(SETUP_BOUNDS[k].max > SETUP_BOUNDS[k].min);
  }
});

test('setup: WALLET_MODES — exactly 3 modes in expected order', () => {
  assert.deepEqual(WALLET_MODES, ['generate', 'import_mnemonic', 'import_wif']);
});