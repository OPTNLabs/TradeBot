// dashboard/tests/explorer-urls.test.mjs
//
// T74 — Pure-helper tests for the dashboard's block-explorer URL
// builder. Pins every URL-construction edge case so future
// explorer migrations can't accidentally regress the helper
// (e.g. accidentally drop the URL-encode, accidentally allow a
// non-64-hex txid, accidentally drop the host).
//
// Coverage:
//   - EXPLORER_BASE_URL  constant value
//   - isValidTxid        (happy 64-hex / uppercase / mixed / non-hex / wrong length / non-string / null / empty)
//   - buildExplorerTxUrl (happy 64-hex / happy uppercase / null / undefined / empty / wrong length / non-hex / non-string / 0x-prefixed / whitespace)
//   - buildExplorerAddressUrl (happy cashaddr / URL-encodes the `:` → `%3A` / no prefix passes through / non-string / null / empty / whitespace-only / whitespace-trim)

import { describe, it } from 'node:test';
import { strictEqual, ok } from 'node:assert';

import {
  EXPLORER_BASE_URL,
  isValidTxid,
  buildExplorerTxUrl,
  buildExplorerAddressUrl,
} from '../src/lib/explorer-urls.mjs';

// ─── EXPLORER_BASE_URL ─────────────────────────────────────────────

describe('EXPLORER_BASE_URL', () => {
  it('is https://explorer.salemkode.com', () => {
    strictEqual(EXPLORER_BASE_URL, 'https://explorer.salemkode.com');
  });
  it('has no trailing slash', () => {
    strictEqual(EXPLORER_BASE_URL.endsWith('/'), false);
  });
});

// ─── isValidTxid ──────────────────────────────────────────────────

describe('isValidTxid', () => {
  it('accepts a 64-hex lowercase txid', () => {
    ok(isValidTxid('a'.repeat(64)));
  });
  it('accepts a 64-hex uppercase txid', () => {
    ok(isValidTxid('A'.repeat(64)));
  });
  it('accepts a 64-hex mixed-case txid', () => {
    ok(isValidTxid('aAbBcCdDeEfF' + '0'.repeat(52)));
  });
  it('rejects a 63-hex txid', () => {
    strictEqual(isValidTxid('a'.repeat(63)), false);
  });
  it('rejects a 65-hex txid', () => {
    strictEqual(isValidTxid('a'.repeat(65)), false);
  });
  it('rejects a non-hex character', () => {
    strictEqual(isValidTxid('z'.repeat(64)), false);
  });
  it('rejects an empty string', () => {
    strictEqual(isValidTxid(''), false);
  });
  it('rejects a non-string', () => {
    strictEqual(isValidTxid(123), false);
    strictEqual(isValidTxid({}), false);
    strictEqual(isValidTxid([]), false);
  });
  it('rejects null and undefined', () => {
    strictEqual(isValidTxid(null), false);
    strictEqual(isValidTxid(undefined), false);
  });
  it('rejects a txid with 0x prefix', () => {
    strictEqual(isValidTxid('0x' + 'a'.repeat(64)), false);
  });
});

// ─── buildExplorerTxUrl ───────────────────────────────────────────

describe('buildExplorerTxUrl', () => {
  const sampleTxid = 'a'.repeat(64);
  const expected = `${EXPLORER_BASE_URL}/tx/${'a'.repeat(64)}`;

  it('builds the tx URL for a valid 64-hex txid', () => {
    strictEqual(buildExplorerTxUrl(sampleTxid), expected);
  });
  it('preserves uppercase hex (lowercase normalization is the explorer\'s job)', () => {
    const upper = 'ABCDEF0123456789'.repeat(4); // 64 chars
    strictEqual(buildExplorerTxUrl(upper), `${EXPLORER_BASE_URL}/tx/${upper}`);
  });
  it('returns null for a null txid', () => {
    strictEqual(buildExplorerTxUrl(null), null);
  });
  it('returns null for an undefined txid', () => {
    strictEqual(buildExplorerTxUrl(undefined), null);
  });
  it('returns null for an empty-string txid', () => {
    strictEqual(buildExplorerTxUrl(''), null);
  });
  it('returns null for a non-string txid', () => {
    strictEqual(buildExplorerTxUrl(123), null);
    strictEqual(buildExplorerTxUrl({}), null);
    strictEqual(buildExplorerTxUrl([]), null);
    strictEqual(buildExplorerTxUrl(true), null);
  });
  it('returns null for a txid that is the wrong length', () => {
    strictEqual(buildExplorerTxUrl('a'.repeat(63)), null);
    strictEqual(buildExplorerTxUrl('a'.repeat(65)), null);
  });
  it('returns null for a txid containing non-hex characters', () => {
    strictEqual(buildExplorerTxUrl('z'.repeat(64)), null);
    strictEqual(buildExplorerTxUrl('g'.repeat(64)), null);
  });
  it('returns null for a txid with whitespace', () => {
    strictEqual(buildExplorerTxUrl(' ' + sampleTxid), null);
    strictEqual(buildExplorerTxUrl(sampleTxid + ' '), null);
  });
  it('never throws on garbage input', () => {
    // Should not throw.
    let threw = false;
    try {
      buildExplorerTxUrl(Symbol('x'));
    } catch (_e) {
      threw = true;
    }
    strictEqual(threw, false);
  });
});

// ─── buildExplorerAddressUrl ──────────────────────────────────────

describe('buildExplorerAddressUrl', () => {
  const cashaddr = 'bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak';
  const expected = `${EXPLORER_BASE_URL}/address/${encodeURIComponent(cashaddr)}`;

  it('builds the address URL for a valid cashaddr', () => {
    strictEqual(buildExplorerAddressUrl(cashaddr), expected);
  });
  it('URL-encodes the `:` in the cashaddr prefix to `%3A`', () => {
    const url = buildExplorerAddressUrl(cashaddr);
    ok(url.includes('%3A'), `expected %3A in ${url}`);
    // Ensure the prefix is URL-encoded, not raw. We test for `bitcoincash%3A`
    // rather than `:bitcoincash` so the host's own `:/` separator
    // doesn't trigger a false positive.
    ok(url.includes('bitcoincash%3A'), `expected encoded bitcoincash%3A in ${url}`);
    ok(!url.includes(':bitcoincash'), `expected no raw :bitcoincash prefix in ${url}`);
  });
  it('works for a token-aware (z-prefix) cashaddr too', () => {
    const zaddr = 'bitcoincash:z9h97cu9y3d8pn8ukp4d0frcy9hvjjwkn2u3pfgmhn6kjn5cqgpuq4pyuc8d';
    const url = buildExplorerAddressUrl(zaddr);
    strictEqual(url, `${EXPLORER_BASE_URL}/address/${encodeURIComponent(zaddr)}`);
  });
  it('trims leading/trailing whitespace before encoding', () => {
    strictEqual(buildExplorerAddressUrl('  ' + cashaddr + '  '), expected);
  });
  it('returns null for null', () => {
    strictEqual(buildExplorerAddressUrl(null), null);
  });
  it('returns null for undefined', () => {
    strictEqual(buildExplorerAddressUrl(undefined), null);
  });
  it('returns null for an empty string', () => {
    strictEqual(buildExplorerAddressUrl(''), null);
  });
  it('returns null for a whitespace-only string', () => {
    strictEqual(buildExplorerAddressUrl('   '), null);
    strictEqual(buildExplorerAddressUrl('\t\n'), null);
  });
  it('returns null for a non-string', () => {
    strictEqual(buildExplorerAddressUrl(123), null);
    strictEqual(buildExplorerAddressUrl({}), null);
    strictEqual(buildExplorerAddressUrl([]), null);
    strictEqual(buildExplorerAddressUrl(true), null);
  });
  it('passes through a non-prefixed address (caller is responsible for validating)', () => {
    const raw = 'qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak';
    strictEqual(buildExplorerAddressUrl(raw), `${EXPLORER_BASE_URL}/address/${raw}`);
  });
  it('never throws on garbage input', () => {
    let threw = false;
    try {
      buildExplorerAddressUrl(Symbol('x'));
    } catch (_e) {
      threw = true;
    }
    strictEqual(threw, false);
  });
});