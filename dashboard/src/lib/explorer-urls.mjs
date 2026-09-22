// dashboard/src/lib/explorer-urls.mjs
//
// T74 — Default block-explorer URL builder for the dashboard.
//
// Establishes a SINGLE place to construct BCH block-explorer
// links so that "view on explorer" buttons across the dashboard
// (WalletReceiveCard, ManualTradePanel, future tiles) all
// point at the same host and the same URL pattern. The
// operator picked https://explorer.salemkode.com/ as the
// canonical BCH explorer; that constant lives here.
//
// URL pattern (verified against the live host before shipping):
//   - transactions:  `${EXPLORER_BASE_URL}/tx/<64-hex-txid>`
//                    (live: HTTP 200)
//   - addresses:     `${EXPLORER_BASE_URL}/address/<urlencoded-cashaddr>`
//                    (live: HTTP 307 → /address/<urlencoded-again> —
//                     Cloudflare normalizes the `:` to `%3A`,
//                     the helper pre-encodes so the dashboard's
//                     href attribute is always normalized already).
//
// Splitting helpers out of the React components (1) keeps the
// dashboard test suite fast + pure-Node (no JSX loader needed),
// and (2) lets every URL-construction edge case be pinned by
// `node --test` so future explorer migrations can't accidentally
// regress.
//
// Failure model: every helper takes a typed input and returns a
// typed output. Bad input → `null`. Callers either substitute a
// fallback or skip the link rather than crashing the tile.

/**
 * Canonical BCH block-explorer base URL (no trailing slash).
 * Picked by the operator — do NOT change without an explicit
 * operator-filed feature idea in `data/feature-ideas.json`.
 *
 * @type {string}
 */
export const EXPLORER_BASE_URL = 'https://explorer.salemkode.com';

// 64 lowercase-or-uppercase hex chars. Standard BCH txid shape.
const TXID_RE = /^[0-9a-fA-F]{64}$/;

/**
 * Pure. True iff `s` is a string shaped like a BCH transaction
 * id (64 hex chars, mixed case allowed). Mirrors the
 * `isValidTxid` checks already used across the dashboard.
 *
 * @param {unknown} s
 * @returns {boolean}
 */
export function isValidTxid(s) {
  if (typeof s !== 'string') return false;
  if (s.length !== 64) return false;
  return TXID_RE.test(s);
}

/**
 * Pure. Build the explorer's transaction-detail URL for `txid`.
 * Returns `null` on bad input — never throws.
 *
 * @param {unknown} txid
 * @returns {string | null}
 */
export function buildExplorerTxUrl(txid) {
  if (!isValidTxid(txid)) return null;
  return `${EXPLORER_BASE_URL}/tx/${txid}`;
}

/**
 * Pure. Build the explorer's address-detail URL for `addr`.
 * The cashaddr prefix `bitcoincash:` is URL-encoded to `%3A`
 * (matching the live host's normalized form). Whitespace is
 * trimmed before encoding. Returns `null` on bad input — never
 * throws.
 *
 * Accepts both legacy `bitcoincash:q...` and token-aware
 * `bitcoincash:z...` cashaddrs; the explorer treats both the
 * same. Raw addresses (no `bitcoincash:` prefix) are passed
 * through URL-encoded too — the explorer's address route will
 * 404 if the format is wrong, but we don't second-guess here
 * (the caller already validated it's a cashaddr).
 *
 * @param {unknown} addr
 * @returns {string | null}
 */
export function buildExplorerAddressUrl(addr) {
  if (typeof addr !== 'string') return null;
  const trimmed = addr.trim();
  if (trimmed.length === 0) return null;
  return `${EXPLORER_BASE_URL}/address/${encodeURIComponent(trimmed)}`;
}