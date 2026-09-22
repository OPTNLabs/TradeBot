// Copied from LifestoneLabs/AI_Skills @ 5640eda484557b7af0105ed09ad3951620e39c17
// Original source: skills/cauldron/scripts/get_token_stats.mjs
//
// Trimmed for in-process library use by TradeBot:
//   - shebang removed
//   - main() + the CLI usage / exit-code paths removed
//   - console.log/error calls removed (library surface; the bot uses the
//     structured logger from src/util/logger.mjs instead)
//   - the indexer fetch is wrapped with a `fetchImpl` injection point so
//     unit tests can swap in a fake response without touching the network
//
// The remaining exports (parseArgs, normalizeTokenId, fmtPctBp, fmtSats,
// fmtUsd, fmtSatsPerToken, buildStatsRecord, findByTokenId, findBySymbol,
// renderStatsBlock) are all pure. `fetchStatsRecords` is the single I/O
// helper the bot calls when it wants the live indexer record.

const INDEXER_DISCOVERY = 'https://indexer.riften.net/cauldron/tokens/list_cached';
const DISCOVERY_LIMIT = 200;

// ────────────── pure helpers ──────────────

/** parseArgs: split argv.slice(2) into positional[] + flags{}. Exported for tests. */
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

/** Canonicalize a token_id to 64 lowercase hex. Throws on bad input. */
export function normalizeTokenId(raw) {
  const s = String(raw).toLowerCase().replace(/^0x/, '').trim();
  if (!/^[0-9a-f]{64}$/.test(s)) {
    throw new Error(`--token-id must be a 64-char hex string (32 bytes); got "${raw}"`);
  }
  return s;
}

/** Convert a basis-point integer to a "+X.XX%" / "-X.XX%" string. */
export function fmtPctBp(bp) {
  if (bp === null || bp === undefined || Number.isNaN(Number(bp))) return 'n/a';
  const n = Number(bp) / 100;
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

/** Format an integer sat / token amount with thousands separators. */
export function fmtSats(n) {
  if (n === null || n === undefined) return 'n/a';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

/** Format a USD price with adaptive precision. */
export function fmtUsd(usd) {
  if (usd === null || usd === undefined) return 'n/a';
  const v = Number(usd);
  if (!Number.isFinite(v)) return 'n/a';
  if (v === 0) return '$0.00';
  if (Math.abs(v) < 0.0001) return `$${v.toExponential(2)}`;
  if (Math.abs(v) < 1) return `$${v.toFixed(6)}`;
  return `$${v.toFixed(2)}`;
}

/** Format a sats-per-token price (the Cauldron spot rate is sats/token). */
export function fmtSatsPerToken(sats) {
  if (sats === null || sats === undefined) return 'n/a';
  const n = Number(sats);
  if (!Number.isFinite(n)) return 'n/a';
  if (n === 0) return '0 sats/tok';
  if (n < 1) return `${n.toExponential(2)} sats/tok`;
  if (n < 1000) return `${n.toFixed(2)} sats/tok`;
  return `${Math.round(n).toLocaleString('en-US')} sats/tok`;
}

/**
 * Build a flat record from an indexer entry. Pure — exported for tests.
 * Returns a stable shape: { token_id, name, symbol, decimals, decimals_warn,
 *   price_now_sats, price_now_usd, price_24h_sats, price_7d_sats,
 *   change_24h_bp, change_24h_usd_bp, change_7d_bp, change_7d_usd_bp,
 *   trade_count, trade_volume_sats, tvl_sats, tvl_tokens, apy_30d_bp,
 *   score, score_rank }.
 */
export function buildStatsRecord(entry) {
  const bcmr = entry.bcmr ?? {};
  const tok = bcmr.token ?? {};
  return {
    token_id: entry.token_id,
    name: entry.display_name ?? bcmr.name ?? null,
    symbol: entry.display_symbol ?? tok.symbol ?? null,
    decimals: tok.decimals ?? null,
    decimals_warn: tok.decimals === undefined ? 'no BCMR decimals — price_now_sats is per display unit' : null,
    price_now_sats: entry.price_now ?? null,
    price_now_usd: entry.price_now_usd ?? null,
    price_24h_sats: entry.price_24h ?? null,
    price_7d_sats: entry.price_7d ?? null,
    change_24h_bp: entry.change_24h_bp ?? null,
    change_24h_usd_bp: entry.change_24h_usd_bp ?? null,
    change_7d_bp: entry.change_7d_bp ?? null,
    change_7d_usd_bp: entry.change_7d_usd_bp ?? null,
    trade_count: entry.trade_count ?? null,
    trade_volume_sats: entry.trade_volume ?? null,
    tvl_sats: entry.tvl_sats ?? null,
    tvl_tokens: entry.tvl_tokens ?? null,
    apy_30d_bp: entry.apy_30d_bp ?? null,
    score: entry.score ?? null,
    score_rank: entry.score_rank ?? null,
  };
}

/**
 * Find an entry in the discovery list by exact token_id match. Returns the
 * raw indexer record or null. Pure — exported for tests.
 */
export function findByTokenId(records, tokenId) {
  if (!Array.isArray(records)) return null;
  return records.find((r) => r?.token_id && String(r.token_id).toLowerCase() === tokenId.toLowerCase()) ?? null;
}

/**
 * Find an entry by case-insensitive symbol match. Prefers `display_symbol`,
 * falls back to `bcmr.token.symbol`. Returns the raw indexer record or null.
 * Pure — exported for tests.
 */
export function findBySymbol(records, symbol) {
  if (!Array.isArray(records) || !symbol) return null;
  const upper = String(symbol).toUpperCase();
  return records.find((r) => {
    const disp = (r?.display_symbol || '').toUpperCase();
    const bcmr = (r?.bcmr?.token?.symbol || '').toUpperCase();
    return disp === upper || bcmr === upper;
  }) ?? null;
}

/**
 * Render a human-readable stats block. Pure — exported for tests.
 */
export function renderStatsBlock(stats) {
  const lines = [
    '───── Cauldron Token Stats ──────────────────────────────',
    `  Token       : ${stats.name ?? '<unknown>'} (${stats.symbol ?? '<unknown>'})`,
    `  Token ID    : ${stats.token_id}`,
  ];
  if (stats.decimals !== null && stats.decimals !== undefined) {
    lines.push(`  Decimals    : ${stats.decimals}`);
  } else if (stats.decimals_warn) {
    lines.push(`  Decimals    : (no BCMR — ${stats.decimals_warn})`);
  }
  lines.push(`  Score rank  : ${stats.score_rank !== null ? `#${stats.score_rank}` : 'n/a'}`);
  lines.push('');
  lines.push('  Price action:');
  lines.push(`    now  : ${fmtSatsPerToken(stats.price_now_sats)} (USD: ${fmtUsd(stats.price_now_usd)})`);
  lines.push(`    24h  : ${fmtSatsPerToken(stats.price_24h_sats)} (Δ ${fmtPctBp(stats.change_24h_bp)} sats, ${fmtPctBp(stats.change_24h_usd_bp)} USD)`);
  lines.push(`    7d   : ${fmtSatsPerToken(stats.price_7d_sats)} (Δ ${fmtPctBp(stats.change_7d_bp)} sats, ${fmtPctBp(stats.change_7d_usd_bp)} USD)`);
  lines.push('');
  lines.push('  Activity:');
  lines.push(`    24h trade count : ${stats.trade_count !== null ? fmtSats(stats.trade_count) : 'n/a'}`);
  lines.push(`    24h volume      : ${stats.trade_volume_sats !== null ? `${fmtSats(stats.trade_volume_sats)} sats` : 'n/a'}`);
  lines.push(`    30d APY         : ${fmtPctBp(stats.apy_30d_bp)}`);
  lines.push('');
  lines.push('  TVL:');
  lines.push(`    BCH   : ${stats.tvl_sats !== null ? `${fmtSats(stats.tvl_sats)} sats (${(Number(stats.tvl_sats) / 1e8).toFixed(4)} BCH)` : 'n/a'}`);
  if (stats.tvl_tokens !== null && stats.decimals !== null && stats.decimals !== undefined) {
    const human = Number(stats.tvl_tokens) / Math.pow(10, stats.decimals);
    lines.push(`    Token : ${fmtSats(stats.tvl_tokens)} base units (≈ ${human.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${stats.symbol ?? 'tokens'})`);
  } else if (stats.tvl_tokens !== null) {
    lines.push(`    Token : ${fmtSats(stats.tvl_tokens)} (raw base units — no BCMR decimals)`);
  }
  return lines.join('\n');
}

// ────────────── I/O helpers ──────────────

/**
 * Fetch the live indexer record (top-200 by TVL). The bot's scoring engine
 * calls this on every poll cycle. Pure with respect to the indexer URL —
 * the actual HTTP layer is injected via `fetchImpl` for unit tests.
 *
 * @param {Object} [opts]
 * @param {(url: string, init?: any) => Promise<any>} [opts.fetchImpl=fetch]
 * @param {number} [opts.limit=200]
 * @returns {Promise<any[]>}
 */
export async function fetchStatsRecords({ fetchImpl = fetch, limit = DISCOVERY_LIMIT } = {}) {
  const url = `${INDEXER_DISCOVERY}?limit=${limit}&by=tvl&order=desc`;
  const r = await fetchImpl(url);
  if (!r.ok) throw new Error(`discovery indexer ${r.status}: ${await r.text()}`);
  const records = await r.json();
  if (!Array.isArray(records)) {
    throw new Error(`discovery indexer returned non-array: ${typeof records}`);
  }
  return records;
}

export const _internals = { INDEXER_DISCOVERY, DISCOVERY_LIMIT };