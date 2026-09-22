// dashboard/src/views/wallet-receive-helpers.mjs
//
// T72 — Pure helpers for the "Wallet Receive" dashboard card.
//
// This card surfaces the bot's BCH cashaddr + a QR code so the
// operator can fund the wallet by sending BCH to it (the canonical
// "deposit to your trading wallet" UX). It reads from
// `/api/wallet/balance` (which returns `{ok, address, network, ...}`)
// — no new backend endpoint is required.
//
// Splitting helpers out of the React component (1) keeps the
// dashboard test suite fast + pure-Node (no JSX loader needed),
// and (2) lets us pin every address-formatting edge case from
// `node --test` exactly like the other tiles do.
//
// Failure model: every helper takes a typed input and returns a
// typed output. Errors are surfaced as `{ok:false, error:'code'}`
// rather than thrown, so the React component can render an
// "unavailable" pill without crashing the surrounding panel.

import qrcode from 'qrcode';

export const RECEIVE_CARD_SCHEMA = 'tradebot.dashboard.wallet-receive/v1';

export const DEFAULT_QR_OPTS = Object.freeze({
  errorCorrectionLevel: 'M',
  margin: 2,
  width: 220,
  color: { dark: '#000000ff', light: '#ffffffff' },
});

// bitcoincash:<body>; lowercase hex, 42-ish chars after the prefix.
const CASHADDR_RE = /^bitcoincash:[a-z0-9]{8,}$/i;

/**
 * Pure. Validate a string looks like a BCH cashaddr. Accepts both
 * legacy `bitcoincash:q...` (BCH-only, q-prefix) and `bitcoincash:z...`
 * (token-aware, z-prefix) — the wallet module uses the q-prefix one
 * for plain BCH receives, but the operator might paste either.
 *
 * @param {unknown} s
 * @returns {boolean}
 */
export function isValidCashaddr(s) {
  if (typeof s !== 'string') return false;
  return CASHADDR_RE.test(s.trim());
}

/**
 * Pure. Slice a (potentially long) cashaddr into display chunks
 * of `chunkLen` characters so the monospace address doesn't run
 * off the edge of the card. Pure: works on any string.
 *
 * @param {string} address
 * @param {number} [chunkLen=12]
 * @returns {string[]}
 */
export function chunkAddress(address, chunkLen = 12) {
  if (typeof address !== 'string' || address.length === 0) return [];
  if (!Number.isFinite(chunkLen) || chunkLen <= 0) return [address];
  const out = [];
  for (let i = 0; i < address.length; i += chunkLen) {
    out.push(address.slice(i, i + chunkLen));
  }
  return out;
}

/**
 * Pure. Shape the `/api/wallet/balance` envelope into the
 * shape the card consumes. Surfaces ok:false when the envelope
 * is missing the address OR when the underlying wallet
 * returned an error envelope.
 *
 * @param {object|null|undefined} env
 * @returns {{ok: boolean, schema: string, address: string|null, network: string|null, error: string|null}}
 */
export function deriveReceiveCardState(env) {
  if (!env || typeof env !== 'object') {
    return { ok: false, schema: RECEIVE_CARD_SCHEMA, address: null, network: null, error: 'wallet_envelope_missing' };
  }
  if (env.ok === false) {
    return { ok: false, schema: RECEIVE_CARD_SCHEMA, address: null, network: null, error: env.error || 'wallet_unavailable' };
  }
  const address = typeof env.address === 'string' ? env.address.trim() : null;
  const network = typeof env.network === 'string' ? env.network.trim() : null;
  if (!address) {
    return { ok: false, schema: RECEIVE_CARD_SCHEMA, address: null, network, error: 'address_missing' };
  }
  if (!isValidCashaddr(address)) {
    return { ok: false, schema: RECEIVE_CARD_SCHEMA, address, network, error: 'address_malformed' };
  }
  return { ok: true, schema: RECEIVE_CARD_SCHEMA, address, network, error: null };
}

/**
 * Pure. Decide which UX hint the card should surface to the
 * operator given the live wallet state. Mirrors the failure
 * model of other tiles: ok:false → "wallet unavailable" pill;
 * ok:true on `mainnet` → standard "send BCH here" hint;
 * ok:true on `chipnet|testnet|test3|test4` → extra
 * "test network" warning so the operator doesn't accidentally
 * send real BCH to a test wallet.
 *
 * @param {{ok: boolean, network: string|null}} state
 * @returns {{kind: 'ok'|'warn'|'error'|'unconfigured', message: string}}
 */
export function deriveReceiveHint(state) {
  if (!state || state.ok === false) {
    return { kind: 'unconfigured', message: 'wallet unavailable — see /api/wallet/balance for the underlying error' };
  }
  const net = (state.network || '').toLowerCase();
  if (net === 'mainnet') {
    return { kind: 'ok', message: 'Send BCH only to this address — sending tokens requires the z-prefix token-aware address (not shown).' };
  }
  if (net === 'chipnet' || net.startsWith('test')) {
    return { kind: 'warn', message: `Test network (${state.network}) — do NOT send real BCH to this address.` };
  }
  if (net === '') {
    return { kind: 'warn', message: 'Network unknown — verify before sending BCH.' };
  }
  return { kind: 'ok', message: `Network: ${state.network}. Send BCH only to this address.` };
}

/**
 * Async. Generate a QR code data-URL (base64-encoded PNG) for a
 * given text. Wraps the `qrcode` package so tests can stub
 * `qrLib.toDataURL` without depending on the real QR generator
 * (the real one takes ~10ms per call and pulls in PNG libs that
 * some test runners don't ship).
 *
 * @param {string} text - cashaddr to encode
 * @param {object} [qrLib] - qrcode-compatible module (defaults to the real package)
 * @param {object} [opts] - QR generation options (merged with DEFAULT_QR_OPTS)
 * @returns {Promise<string>} `data:image/png;base64,...` URL suitable for <img src>
 */
export async function buildQrDataUrl(text, qrLib = qrcode, opts = {}) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('buildQrDataUrl: text must be a non-empty string');
  }
  if (!qrLib || typeof qrLib.toDataURL !== 'function') {
    throw new Error('buildQrDataUrl: qrLib with toDataURL required');
  }
  const merged = { ...DEFAULT_QR_OPTS, ...opts };
  return qrLib.toDataURL(text, merged);
}

/**
 * Pure. Severity class for the card header pill. Mirrors the
 * `lockNftCountClass`/`autoStakeClass` conventions used by the
 * staking card so the dashboard's tailwind classes stay
 * consistent.
 *
 * @param {{kind: string}} hint
 * @returns {string}
 */
export function receiveHintClass(hint) {
  switch (hint?.kind) {
    case 'ok': return 'text-emerald-300';
    case 'warn': return 'text-amber-300';
    case 'error': return 'text-red-300';
    case 'unconfigured':
    default: return 'text-slate-400';
  }
}
