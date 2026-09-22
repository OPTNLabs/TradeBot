// Copied from LifestoneLabs/AI_Skills @ 5640eda484557b7af0105ed09ad3951620e39c17
// Original source: skills/cauldron/scripts/get_bcmr.mjs
//
// Trimmed for in-process library use by TradeBot:
//   - shebang + main() + the CLI usage paths removed
//   - console.log/error calls removed
//   - the network layer is injectable (fetchImpl) for unit tests
//
// Exports: parseArgs, normalizeTokenId, resolveBcmr, resolveSymbolToId,
// INDEXER_HOSTS, INDEXER_CHIPNET_HOSTS, INDEXER_DISCOVERY, PREFER_REGEX.

export const INDEXER_HOSTS = [
  'https://indexer.cauldron.quest',
  'https://indexer.riften.net',
];
export const INDEXER_CHIPNET_HOSTS = [
  'https://indexer-chipnet.riften.net',
];
export const INDEXER_DISCOVERY = 'https://indexer.riften.net/cauldron/tokens/list_cached';

// Canonical `--prefer=` regex used to validate that a user-supplied host
// matches one of the two known indexers (cauldron.quest or riften.net).
export const PREFER_REGEX = /^https:\/\/(indexer\.cauldron\.quest|indexer(-chipnet)?\.riften\.net)/;

// ---- args ----------------------------------------------------------------

export function parseArgs(argv) {
  const out = { positional: [], flags: {} };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq >= 0) out.flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      else out.flags[arg.slice(2)] = true;
    } else {
      out.positional.push(arg);
    }
  }
  return out;
}

// ---- helpers -------------------------------------------------------------

export function normalizeTokenId(raw) {
  const s = String(raw).toLowerCase().replace(/^0x/, '').trim();
  if (!/^[0-9a-f]{64}$/.test(s)) {
    throw new Error(`--token-id must be a 64-char hex string (32 bytes); got "${raw}"`);
  }
  return s;
}

export async function fetchWithTimeout(url, ms = 8000, { fetchImpl = fetch } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetchImpl(url, { signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function probeBcmr(host, tokenId, { fetchImpl = fetch } = {}) {
  const url = `${host}/bcmr/token/${tokenId}`;
  const r = await fetchWithTimeout(url, 8000, { fetchImpl });
  if (r.status === 404) return { status: 'not_found', host };
  if (!r.ok) throw new Error(`${host}/bcmr/token/${tokenId} → HTTP ${r.status}`);
  const raw = await r.text();
  if (raw === 'null' || raw.trim() === '') return { status: 'null', host };
  let body;
  try {
    body = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${host}/bcmr/token/${tokenId} returned non-JSON: ${raw.slice(0, 80)}`);
  }
  if (body === null) return { status: 'null', host };
  return { status: 'found', host, body };
}

export async function resolveBcmr(tokenId, { chipnet = false, prefer = null, fetchImpl = fetch } = {}) {
  const hosts = prefer
    ? [prefer].filter(Boolean)
    : chipnet
      ? INDEXER_CHIPNET_HOSTS
      : INDEXER_HOSTS;

  let lastStatus = null;
  for (const host of hosts) {
    try {
      const r = await probeBcmr(host, tokenId, { fetchImpl });
      lastStatus = r;
      if (r.status === 'found') return r;
    } catch (e) {
      lastStatus = { status: 'error', host, message: e.message };
    }
  }
  return lastStatus || { status: 'no_hosts' };
}

export async function resolveSymbolToId(symbol, { fetchImpl = fetch } = {}) {
  const upper = symbol.toUpperCase();
  const r = await fetchWithTimeout(`${INDEXER_DISCOVERY}?limit=100&by=tvl&order=desc`, 8000, { fetchImpl });
  if (!r.ok) throw new Error(`discovery endpoint ${INDEXER_DISCOVERY} → HTTP ${r.status}`);
  const tokens = await r.json();
  if (!Array.isArray(tokens)) {
    throw new Error(`unexpected discovery response: not an array`);
  }
  const found = tokens.find((t) => (t.display_symbol || '').toUpperCase() === upper)
    || tokens.find((t) => (t.bcmr?.token?.symbol || '').toUpperCase() === upper);
  if (!found) {
    throw new Error(
      `Token with symbol "${symbol}" not found in top-100 by TVL. ` +
      `Pass --token-id=<64-hex> instead.`,
    );
  }
  return found;
}