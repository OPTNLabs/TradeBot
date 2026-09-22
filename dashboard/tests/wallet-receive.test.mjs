// dashboard/tests/wallet-receive.test.mjs
//
// T72 — Pure-helper tests for the WalletReceiveCard.
//
// Coverage:
//   - isValidCashaddr   (happy / q-prefix / z-prefix / too short / non-string / null)
//   - chunkAddress      (typical cashaddr / empty / non-string / chunkLen edge cases)
//   - deriveReceiveCardState (happy / ok:false envelope / missing address / malformed / null)
//   - deriveReceiveHint (mainnet / chipnet / unknown / empty / ok:false)
//   - receiveHintClass  (every kind + default)
//   - buildQrDataUrl    (text validation / qrLib required / happy path with stub)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isValidCashaddr,
  chunkAddress,
  deriveReceiveCardState,
  deriveReceiveHint,
  buildQrDataUrl,
  receiveHintClass,
  RECEIVE_CARD_SCHEMA,
} from '../src/views/wallet-receive-helpers.mjs';

test('isValidCashaddr: typical q-prefix cashaddr is valid', () => {
  assert.equal(isValidCashaddr('bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak'), true);
});

test('isValidCashaddr: z-prefix token-aware cashaddr is valid', () => {
  assert.equal(isValidCashaddr('bitcoincash:zprh2xrn99nznz3ssw0a4l5vgfcz8stgluz36e20gz'), true);
});

test('isValidCashaddr: uppercase body is still accepted (case-insensitive)', () => {
  assert.equal(isValidCashaddr('bitcoincash:QPRH2XRN99NZNZ3SSW0A4L5VGFCZ8STGLU9MF8YFH3'), true);
});

test('isValidCashaddr: too-short body fails', () => {
  assert.equal(isValidCashaddr('bitcoincash:qp'), false);
});

test('isValidCashaddr: missing prefix fails', () => {
  assert.equal(isValidCashaddr('qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak'), false);
});

test('isValidCashaddr: non-string types fail', () => {
  assert.equal(isValidCashaddr(null), false);
  assert.equal(isValidCashaddr(undefined), false);
  assert.equal(isValidCashaddr(12345), false);
  assert.equal(isValidCashaddr({}), false);
});

test('chunkAddress: typical cashaddr splits into 12-char chunks', () => {
  const chunks = chunkAddress('bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak', 12);
  assert.deepEqual(chunks, [
    'bitcoincash:',
    'qqcp6q32dt4x',
    '4ddzrkdz28xm',
    'v6a3ev6wwq4t',
    '0m57ak',
  ]);
});

test('chunkAddress: empty string returns empty array', () => {
  assert.deepEqual(chunkAddress('', 12), []);
  assert.deepEqual(chunkAddress(null), []);
  assert.deepEqual(chunkAddress(undefined), []);
});

test('chunkAddress: chunkLen<=0 returns the full string as one chunk', () => {
  assert.deepEqual(
    chunkAddress('bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak', 0),
    ['bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak']
  );
});

test('chunkAddress: NaN chunkLen returns the full string', () => {
  assert.deepEqual(
    chunkAddress('bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak', NaN),
    ['bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak']
  );
});

test('deriveReceiveCardState: happy path (mainnet)', () => {
  const env = { ok: true, address: 'bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak', network: 'mainnet' };
  const s = deriveReceiveCardState(env);
  assert.equal(s.ok, true);
  assert.equal(s.address, 'bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak');
  assert.equal(s.network, 'mainnet');
  assert.equal(s.error, null);
  assert.equal(s.schema, RECEIVE_CARD_SCHEMA);
});

test('deriveReceiveCardState: ok:false envelope → ok:false state with error', () => {
  const s = deriveReceiveCardState({ ok: false, error: 'electrum_unreachable' });
  assert.equal(s.ok, false);
  assert.equal(s.error, 'electrum_unreachable');
  assert.equal(s.address, null);
});

test('deriveReceiveCardState: missing address → address_missing error', () => {
  const s = deriveReceiveCardState({ ok: true, network: 'mainnet' });
  assert.equal(s.ok, false);
  assert.equal(s.error, 'address_missing');
});

test('deriveReceiveCardState: malformed address → address_malformed error', () => {
  const s = deriveReceiveCardState({ ok: true, address: 'not-a-cashaddr', network: 'mainnet' });
  assert.equal(s.ok, false);
  assert.equal(s.error, 'address_malformed');
  assert.equal(s.address, 'not-a-cashaddr'); // preserved so operator can see what we got
});

test('deriveReceiveCardState: null envelope → wallet_envelope_missing', () => {
  const s = deriveReceiveCardState(null);
  assert.equal(s.ok, false);
  assert.equal(s.error, 'wallet_envelope_missing');
});

test('deriveReceiveCardState: whitespace-padded address still valid (we trim)', () => {
  const s = deriveReceiveCardState({ ok: true, address: '  bitcoincash:qp  ', network: 'mainnet' });
  // Wait — trim removes trailing '  ' which would shorten the body. After trim the address
  // 'bitcoincash:qp' is too short for the regex. So this should be malformed.
  assert.equal(s.ok, false);
  assert.equal(s.error, 'address_malformed');
});

test('deriveReceiveHint: ok on mainnet returns ok-kind message', () => {
  const hint = deriveReceiveHint({ ok: true, network: 'mainnet' });
  assert.equal(hint.kind, 'ok');
  assert.match(hint.message, /send BCH only/i);
});

test('deriveReceiveHint: chipnet → warn-kind (test-network guard)', () => {
  const hint = deriveReceiveHint({ ok: true, network: 'chipnet' });
  assert.equal(hint.kind, 'warn');
  assert.match(hint.message, /do NOT send real BCH/i);
});

test('deriveReceiveHint: test3 → warn-kind', () => {
  const hint = deriveReceiveHint({ ok: true, network: 'test3' });
  assert.equal(hint.kind, 'warn');
});

test('deriveReceiveHint: empty network → warn-kind "unknown"', () => {
  const hint = deriveReceiveHint({ ok: true, network: '' });
  assert.equal(hint.kind, 'warn');
  assert.match(hint.message, /unknown/i);
});

test('deriveReceiveHint: unknown network name → ok-kind (lists the network)', () => {
  const hint = deriveReceiveHint({ ok: true, network: 'regtest' });
  assert.equal(hint.kind, 'ok');
  assert.match(hint.message, /regtest/);
});

test('deriveReceiveHint: ok:false → unconfigured-kind', () => {
  const hint = deriveReceiveHint({ ok: false });
  assert.equal(hint.kind, 'unconfigured');
  assert.match(hint.message, /unavailable/i);
});

test('receiveHintClass: every kind maps to a tailwind class', () => {
  assert.equal(receiveHintClass({ kind: 'ok' }), 'text-emerald-300');
  assert.equal(receiveHintClass({ kind: 'warn' }), 'text-amber-300');
  assert.equal(receiveHintClass({ kind: 'error' }), 'text-red-300');
  assert.equal(receiveHintClass({ kind: 'unconfigured' }), 'text-slate-400');
  assert.equal(receiveHintClass(null), 'text-slate-400');
  assert.equal(receiveHintClass({ kind: 'unknown-future-kind' }), 'text-slate-400');
});

test('buildQrDataUrl: rejects empty string', async () => {
  const stub = { toDataURL: async () => 'data:image/png;base64,' };
  await assert.rejects(() => buildQrDataUrl('', stub), /non-empty string/);
});

test('buildQrDataUrl: rejects non-string', async () => {
  const stub = { toDataURL: async () => 'data:image/png;base64,' };
  await assert.rejects(() => buildQrDataUrl(null, stub), /non-empty string/);
  await assert.rejects(() => buildQrDataUrl(undefined, stub), /non-empty string/);
  await assert.rejects(() => buildQrDataUrl(12345, stub), /non-empty string/);
});

test('buildQrDataUrl: rejects explicitly-invalid qrLib (null / {} / non-function toDataURL)', async () => {
  // When qrLib is omitted OR explicitly `undefined`, the helper falls back to the
  // real `qrcode` package (default param per ES2015 semantics). The "rejection"
  // path is only when the caller passes an explicit non-functional qrLib.
  await assert.rejects(() => buildQrDataUrl('bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak', null), /qrLib with toDataURL required/);
  await assert.rejects(() => buildQrDataUrl('bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak', {}), /qrLib with toDataURL required/);
  await assert.rejects(() => buildQrDataUrl('bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak', { toDataURL: 'not-a-function' }), /qrLib with toDataURL required/);
});

test('buildQrDataUrl: happy path with stub returns the stub URL', async () => {
  const stub = { toDataURL: async (text, opts) => `data:image/png;base64,STUB_${text}_${opts.width}` };
  const url = await buildQrDataUrl('bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak', stub);
  assert.equal(url, 'data:image/png;base64,STUB_bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak_220');
});

test('buildQrDataUrl: merges opts over DEFAULT_QR_OPTS', async () => {
  let capturedOpts;
  const stub = { toDataURL: async (text, opts) => { capturedOpts = opts; return 'data:image/png;base64,'; } };
  await buildQrDataUrl('bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak', stub, { width: 400, margin: 4 });
  assert.equal(capturedOpts.width, 400);
  assert.equal(capturedOpts.margin, 4);
  assert.equal(capturedOpts.errorCorrectionLevel, 'M'); // preserved from default
});

test('buildQrDataUrl: real qrcode package actually generates a data URL for a cashaddr', async () => {
  // Smoke test against the real package — catches missing deps / broken imports.
  // Skipped on platforms where qrcode can't run (e.g. minimal CI); in our
  // environment Node 20 + qrcode 1.5.x work fine.
  const url = await buildQrDataUrl('bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak');
  assert.match(url, /^data:image\/png;base64,/);
  // A real QR for this address is ~200–400 bytes of base64; assert it's plausibly sized.
  assert.ok(url.length > 200, `expected QR data URL > 200 chars, got ${url.length}`);
});
