#!/usr/bin/env node
/**
 * scripts/pull-data.mjs
 *
 * Reusable Cauldron data-pull CLI. Wraps `src/data/fetcher.mjs` for:
 *   --list-pools [token-id]   Dump active pools for one token (or all top-200 if no token-id)
 *   --token-stats <id>        Dump PoolStats + BCMR metadata for one token
 *   --snapshot-all            One full snapshot: all top-200 pools + per-token stats
 *   --top20                   Compute composite top-20 and write data/top-tokens.json
 *   --report <symbol-or-id>   Generate docs/reports/<symbol>.md for one token
 *
 * Read-only — never signs, never broadcasts, never touches the WIF.
 *
 * Usage:
 *   node scripts/pull-data.mjs --list-pools [token-id] [--json] [--out=<file>]
 *   node scripts/pull-data.mjs --token-stats <id-or-symbol> [--json] [--out=<file>]
 *   node scripts/pull-data.mjs --snapshot-all [--date=YYYY-MM-DD]
 *   node scripts/pull-data.mjs --top20
 *   node scripts/pull-data.mjs --report <symbol-or-id>
 */

import {
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  mkdtempSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';

import {
  createFetcher,
  IndexerError,
  IndexerHttpError,
  IndexerTimeoutError,
  IndexerShapeError,
  bchFromSats,
} from '../src/data/fetcher.mjs';

import { isValidPool, isValidPoolStats, isValidTokenId } from '../src/data/types.mjs';

import { createLogger } from '../src/util/logger.mjs';

// ─── Logger ────────────────────────────────────────────────────────────────

const log = createLogger({ component: 'pull-data' });

// ─── CLI helpers ────────────────────────────────────────────────────────────

const HELP = `
TradeBot data pull CLI — read-only Cauldron indexer client.

Usage:
  node scripts/pull-data.mjs --list-pools [token-id] [--json] [--out=<path>]
  node scripts/pull-data.mjs --token-stats <id-or-symbol> [--json] [--out=<path>]
  node scripts/pull-data.mjs --snapshot-all [--date=YYYY-MM-DD]
  node scripts/pull-data.mjs --top20
  node scripts/pull-data.mjs --report <symbol-or-id>

Flags:
  --list-pools [token-id]   List active pools (all top-200 if no token-id given)
  --token-stats <id>         Get PoolStats + BCMR for one token
  --snapshot-all             Full snapshot: pools + per-token stats → data/snapshots/<date>/
  --top20                    Compute composite top-20 → data/top-tokens.json
  --report <sym-or-id>       Generate token report → docs/reports/<sym>.md
  --json                     JSON output (instead of human-readable)
  --out=<path>               Write output to <path> instead of stdout
  --date=YYYY-MM-DD          Override snapshot date (default: today)
  --help                     Show this help
`.trim();

/**
 * Minimal arg parser — handles --flag, --key=value, and positional args.
 * @param {string[]} argv
 * @returns {{ flags: Record<string, string|true>, positional: string[] }}
 */
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (const arg of argv.slice(2)) {
    if (arg === '--') continue;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq >= 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

/**
 * Write output to file (atomic) or stdout.
 * @param {unknown} data
 * @param {string|undefined} outPath
 * @param {boolean} asJson
 */
function emit(data, outPath, asJson) {
  const text = asJson
    ? JSON.stringify(data, null, 2)
    : typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  if (outPath) {
    atomicWrite(outPath, text);
    log.info('written', { path: outPath, size: text.length });
  } else {
    process.stdout.write(text + '\n');
  }
}

/**
 * Atomic write: write to temp file then rename.
 * @param {string} filePath
 * @param {string} content
 */
function atomicWrite(filePath, content) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = mkdtempSync(tmpdir() + '/tradebot-pull-');
  const tmpFile = tmp + '/file';
  writeFileSync(tmpFile, content, 'utf8');
  renameSync(tmpFile, filePath);
}

// ─── Composite score (shared, exported for tests) ───────────────────────────

/**
 * Compute a simple composite score for ranking tokens.
 * Formula: volume_sats * tvl_sats * (1 + |change_24h_bp| / 10000)
 * Higher = more attractive. Null fields treated as 1 (neutral).
 *
 * @param {import('../src/data/types.mjs').PoolStats} stats
 * @returns {number}
 */
export function compositeScore(stats) {
  const vol = stats.trade_volume_sats ?? 0;
  const tvl = stats.tvl_sats ?? 0;
  const chg = Math.abs(stats.change_24h_bp ?? 0) / 10000;
  return vol * tvl * (1 + chg);
}

/**
 * Rank tokens by composite score descending.
 * @param {import('../src/data/types.mjs').PoolStats[]} tokenStatsList
 * @returns {Array<{ rank: number, token_id: string, symbol: string|null, name: string|null, score: number, stats: PoolStats }>}
 */
export function rankTokens(tokenStatsList) {
  return tokenStatsList
    .filter((s) => s.token_id && isValidPoolStats(s))
    .map((s) => ({ token_id: s.token_id, symbol: s.symbol ?? null, name: s.name ?? null, score: compositeScore(s), stats: s }))
    .sort((a, b) => b.score - a.score)
    .map((item, i) => ({ rank: i + 1, ...item }));
}

// ─── Formatters ─────────────────────────────────────────────────────────────

function fmtSats(n) {
  if (n === null || n === undefined) return 'n/a';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function fmtBch(sats) {
  if (sats === null || sats === undefined) return 'n/a';
  const bch = bchFromSats(sats);
  if (bch === null) return 'n/a';
  return `${bch.toFixed(8)} BCH`;
}

function fmtPct(bp) {
  if (bp === null || bp === undefined) return 'n/a';
  return `${(Number(bp) / 100).toFixed(2)}%`;
}

function fmtUsd(usd) {
  if (usd === null || usd === undefined) return 'n/a';
  const v = Number(usd);
  if (!Number.isFinite(v)) return 'n/a';
  if (v < 0.0001) return `$${v.toExponential(2)}`;
  if (Math.abs(v) < 1) return `$${v.toFixed(6)}`;
  return `$${v.toFixed(2)}`;
}

function fmtSatsPerToken(sats) {
  if (sats === null || sats === undefined) return 'n/a';
  const n = Number(sats);
  if (!Number.isFinite(n)) return 'n/a';
  if (n === 0) return '0 sats/tok';
  if (n < 1) return `${n.toExponential(2)} sats/tok`;
  if (n < 1000) return `${n.toFixed(2)} sats/tok`;
  return `${Math.round(n).toLocaleString('en-US')} sats/tok`;
}

// ─── Command: list-pools ─────────────────────────────────────────────────────

/**
 * @param {string} [tokenIdRaw]
 * @param {{ json?: boolean, out?: string }} opts
 */
async function cmdListPools(tokenIdRaw, opts = {}) {
  const fetcher = createFetcher({ logger: log });
  const asJson = !!opts.json;
  const outPath = opts.out;

  if (tokenIdRaw) {
    // Validate token_id format before hitting the indexer
    if (!isValidTokenId(tokenIdRaw)) {
      throw new TypeError(`--list-pools: "${tokenIdRaw}" is not a valid 64-char hex token_id`);
    }
    const pools = await fetcher.listPools(tokenIdRaw);
    if (asJson) {
      emit(pools, outPath, true);
    } else {
      if (pools.length === 0) {
        emit(`No active pools found for token: ${tokenIdRaw}`, outPath, false);
        return;
      }
      let i = 0;
      const lines = [`Active Cauldron pools for ${tokenIdRaw}: ${pools.length}\n`];
      for (const p of pools) {
        const rate = Number(p.tokens) > 0 ? (Number(p.sats) / Number(p.tokens)).toFixed(4) : '∞';
        lines.push(
          `  ${++i}. pool ${p.pool_id.slice(0, 16)}…  ` +
          `${fmtSats(p.sats)} sats (${fmtBch(p.sats)})  +  ` +
          `${fmtSats(p.tokens)} tokens`
        );
        lines.push(`     rate: ${rate} sats/token   owner: ${p.owner_p2pkh_addr}`);
        lines.push(`     utxo: ${p.txid}:${p.tx_pos}`);
        lines.push('');
      }
      emit(lines.join('\n').trim(), outPath, false);
    }
  } else {
    // No token-id → dump all top-200 discovery entries
    const tokens = await fetcher.listTopTokens({ by: 'tvl', order: 'desc', limit: 200 });
    if (asJson) {
      emit(tokens, outPath, true);
    } else {
      const lines = [`Top ${tokens.length} tokens by TVL:\n`];
      for (const t of tokens) {
        const sym = t.display_symbol ?? t.bcmr?.token?.symbol ?? '???';
        const name = t.display_name ?? t.bcmr?.name ?? '???';
        lines.push(
          `  ${t.score_rank ?? '?'}. ${sym} (${name})`
        );
        lines.push(
          `     price: ${fmtSatsPerToken(t.price_now)}  USD: ${fmtUsd(t.price_now_usd)}  ` +
          `24h: ${fmtPct(t.change_24h_bp)}  7d: ${fmtPct(t.change_7d_bp)}`
        );
        lines.push(
          `     TVL: ${fmtBch(t.tvl_sats)}  vol(24h): ${fmtBch(t.trade_volume)}  ` +
          `APY: ${fmtPct(t.apy_30d_bp)}`
        );
        lines.push(`     token_id: ${t.token_id}`);
        lines.push('');
      }
      emit(lines.join('\n').trim(), outPath, false);
    }
  }
}

// ─── Command: token-stats ────────────────────────────────────────────────────

/**
 * @param {string} idOrSymbol
 * @param {{ json?: boolean, out?: string }} opts
 */
async function cmdTokenStats(idOrSymbol, opts = {}) {
  const fetcher = createFetcher({ logger: log });
  const asJson = !!opts.json;
  const outPath = opts.out;

  // Try as token_id first; if that fails (IndexerShapeError), fall back to symbol lookup
  let stats;
  let bcmr;
  let inputMode;
  let resolvedTokenId;

  if (isValidTokenId(idOrSymbol)) {
    inputMode = 'token-id';
    try {
      stats = await fetcher.getTokenStats(idOrSymbol);
      resolvedTokenId = idOrSymbol;
    } catch (e) {
      if (e instanceof IndexerShapeError) {
        log.warn('token-id not in top-200, trying symbol lookup', { idOrSymbol, err: e.message });
        // Fall through to symbol lookup
        inputMode = 'symbol';
      } else {
        throw e;
      }
    }
  }

  if (!stats) {
    inputMode = 'symbol';
    stats = await fetcher.getTokenStatsBySymbol(idOrSymbol);
    resolvedTokenId = stats.token_id;
  }

  bcmr = await fetcher.getBcmr(resolvedTokenId);

  if (asJson) {
    emit({ inputMode, tokenId: resolvedTokenId, stats, bcmr }, outPath, true);
  } else {
    const lines = [
      '───── Token Stats ──────────────────────────────────────',
      `  Mode       : ${inputMode === 'token-id' ? 'direct token_id' : `symbol "${idOrSymbol}" → ${resolvedTokenId}`}`,
      `  Token      : ${stats.name ?? '<unknown>'} (${stats.symbol ?? '<unknown>'})`,
      `  Token ID  : ${stats.token_id}`,
      `  Decimals  : ${stats.decimals ?? 'n/a'}${stats.decimals_warn ? ` (${stats.decimals_warn})` : ''}`,
      `  Score rank : ${stats.score_rank !== null ? `#${stats.score_rank}` : 'n/a'}`,
      '',
      '  Price:',
      `    now  : ${fmtSatsPerToken(stats.price_now_sats)}  USD: ${fmtUsd(stats.price_now_usd)}`,
      `    24h  : ${fmtSatsPerToken(stats.price_24h_sats)}  Δ ${fmtPct(stats.change_24h_bp)} sats, ${fmtPct(stats.change_24h_usd_bp)} USD`,
      `    7d   : ${fmtSatsPerToken(stats.price_7d_sats)}  Δ ${fmtPct(stats.change_7d_bp)} sats, ${fmtPct(stats.change_7d_usd_bp)} USD`,
      '',
      '  Activity:',
      `    24h trade count : ${stats.trade_count !== null ? fmtSats(stats.trade_count) : 'n/a'}`,
      `    24h volume     : ${stats.trade_volume_sats !== null ? `${fmtSats(stats.trade_volume_sats)} sats (${fmtBch(stats.trade_volume_sats)})` : 'n/a'}`,
      `    30d APY        : ${fmtPct(stats.apy_30d_bp)}`,
      '',
      '  TVL:',
      `    BCH  : ${stats.tvl_sats !== null ? fmtBch(stats.tvl_sats) : 'n/a'}`,
      stats.tvl_tokens !== null && stats.decimals != null
        ? `    Token: ${fmtSats(stats.tvl_tokens)} base units (≈ ${(Number(stats.tvl_tokens) / Math.pow(10, stats.decimals)).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${stats.symbol ?? 'tokens'})`
        : stats.tvl_tokens !== null
          ? `    Token: ${fmtSats(stats.tvl_tokens)} (raw — no BCMR decimals)`
          : null,
      '',
      '  BCMR:',
      bcmr
        ? `    Name       : ${bcmr.name ?? 'n/a'}`
        : '    No BCMR metadata (token has no authchain commitment)',
    ];
    if (bcmr?.description) {
      lines.push(`    Desc       : ${String(bcmr.description).slice(0, 200)}${bcmr.description.length > 200 ? '…' : ''}`);
    }
    emit(lines.filter(Boolean).join('\n'), outPath, false);
  }
}

// ─── Command: snapshot-all ──────────────────────────────────────────────────

/**
 * @param {{ date?: string }} opts
 */
async function cmdSnapshotAll(opts = {}) {
  const date = opts.date || new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const snapDir = `data/snapshots/${date}`;
  const fetcher = createFetcher({ logger: log });

  log.info('snapshot-all start', { date });

  // 1. Pull full top-200 discovery list
  const tokens = await fetcher.listTopTokens({ by: 'tvl', order: 'desc', limit: 200 });
  atomicWrite(`${snapDir}/pools.json`, JSON.stringify(tokens, null, 2));
  log.info('pools.json written', { count: tokens.length, date });

  // 2. Per-token stats — pull in batches of 20 (rate-limit friendly)
  mkdirSync(`${snapDir}/token-stats`, { recursive: true });
  const batchSize = 20;
  for (let i = 0; i < tokens.length; i += batchSize) {
    const batch = tokens.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (t) => {
        try {
          const stats = await fetcher.getTokenStats(t.token_id);
          atomicWrite(`${snapDir}/token-stats/${t.token_id}.json`, JSON.stringify(stats, null, 2));
        } catch (e) {
          log.warn('getTokenStats failed, skipping', { token_id: t.token_id, err: e?.message });
        }
      })
    );
    // Small delay between batches to be kind to the indexer
    if (i + batchSize < tokens.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // 3. Append to history.ndjson
  const topToken = tokens[0];
  const topSymbol = topToken?.display_symbol ?? topToken?.bcmr?.token?.symbol ?? topToken?.token_id ?? 'unknown';
  const historyLine = JSON.stringify({
    ts: new Date().toISOString(),
    source: 'snapshot',
    type: 'full-snapshot',
    date,
    pool_count: tokens.length,
    top_token: topSymbol,
  });
  appendHistory(historyLine);

  log.info('snapshot-all done', { date, pool_count: tokens.length, top_token: topSymbol });

  // Return summary for caller
  return { date, pool_count: tokens.length, top_token: topSymbol };
}

/**
 * Append a line to history.ndjson (never truncates).
 * Uses append-mode file open so concurrent ticks can't tear writes.
 * @param {string} line
 */
function appendHistory(line) {
  const filePath = 'data/history.ndjson';
  mkdirSync(dirname(filePath) || '.', { recursive: true });
  if (!existsSync(filePath)) {
    // Create empty file (first-ever write) then fall through to append.
    writeFileSync(filePath, '', 'utf8');
  }
  // O_APPEND makes POSIX guarantee atomic appends ≤ PIPE_BUF (4096 bytes
  // on Linux). Our history lines are <512 bytes so they're atomic.
  appendFileSync(filePath, line + '\n', 'utf8');
}

// ─── Command: top20 ──────────────────────────────────────────────────────────

/**
 * Compute top-20 by composite score and write to data/top-tokens.json
 */
async function cmdTop20() {
  const fetcher = createFetcher({ logger: log });
  log.info('top20 start');

  const tokens = await fetcher.listTopTokens({ by: 'tvl', order: 'desc', limit: 200 });

  // Build PoolStats-like records from the raw entries (no per-token fetch needed for ranking)
  /** @type {import('../src/data/types.mjs').PoolStats[]} */
  const statsList = tokens.map((t) => ({
    token_id: t.token_id,
    name: t.display_name ?? t.bcmr?.name ?? null,
    symbol: t.display_symbol ?? t.bcmr?.token?.symbol ?? null,
    decimals: t.bcmr?.token?.decimals ?? null,
    decimals_warn: t.bcmr?.token?.decimals === undefined ? 'no BCMR decimals — price_now_sats is per display unit' : null,
    price_now_sats: t.price_now ?? null,
    price_now_usd: t.price_now_usd ?? null,
    price_24h_sats: t.price_24h ?? null,
    price_7d_sats: t.price_7d ?? null,
    change_24h_bp: t.change_24h_bp ?? null,
    change_24h_usd_bp: t.change_24h_usd_bp ?? null,
    change_7d_bp: t.change_7d_bp ?? null,
    change_7d_usd_bp: t.change_7d_usd_bp ?? null,
    trade_count: t.trade_count ?? null,
    trade_volume_sats: t.trade_volume ?? null,
    tvl_sats: t.tvl_sats ?? null,
    tvl_tokens: t.tvl_tokens ?? null,
    apy_30d_bp: t.apy_30d_bp ?? null,
    score: t.score ?? null,
    score_rank: t.score_rank ?? null,
  }));

  const ranked = rankTokens(statsList).slice(0, 20);

  const payload = {
    computed_at: new Date().toISOString(),
    composite_formula: 'volume_sats * tvl_sats * (1 + |change_24h_bp| / 10000)',
    tokens: ranked.map((r) => ({
      rank: r.rank,
      token_id: r.token_id,
      symbol: r.symbol,
      name: r.name,
      composite_score: r.score,
      volume_24h_sats: r.stats.trade_volume_sats,
      tvl_sats: r.stats.tvl_sats,
      change_24h_bp: r.stats.change_24h_bp,
      price_now_sats: r.stats.price_now_sats,
      price_now_usd: r.stats.price_now_usd,
      tvl_bch: r.stats.tvl_sats !== null ? bchFromSats(r.stats.tvl_sats) : null,
      volume_24h_bch: r.stats.trade_volume_sats !== null ? bchFromSats(r.stats.trade_volume_sats) : null,
      apy_30d_bp: r.stats.apy_30d_bp,
    })),
  };

  atomicWrite('data/top-tokens.json', JSON.stringify(payload, null, 2));
  log.info('top-tokens.json written', { count: ranked.length, top: ranked[0]?.symbol });

  return payload;
}

// ─── Command: report ─────────────────────────────────────────────────────────

/**
 * Generate a per-token markdown report.
 * @param {string} symbolOrId
 */
async function cmdReport(symbolOrId) {
  const fetcher = createFetcher({ logger: log });
  log.info('report start', { symbolOrId });

  // Resolve to stats + bcmr
  let stats;
  let inputMode;
  let resolvedTokenId;

  if (isValidTokenId(symbolOrId)) {
    inputMode = 'token-id';
    try {
      stats = await fetcher.getTokenStats(symbolOrId);
      resolvedTokenId = symbolOrId;
    } catch (e) {
      if (e instanceof IndexerShapeError) {
        inputMode = 'symbol (fallback)';
      } else throw e;
    }
  }

  if (!stats) {
    inputMode = 'symbol';
    stats = await fetcher.getTokenStatsBySymbol(symbolOrId);
    resolvedTokenId = stats.token_id;
  }

  const bcmr = await fetcher.getBcmr(resolvedTokenId);

  const sym = stats.symbol ?? symbolOrId;
  const poolUrl = `https://cauldron.quest/token/${resolvedTokenId}`;

  // Format numbers
  const priceNowSats = stats.price_now_sats;
  const priceNowBch = priceNowSats !== null ? (priceNowSats / 100_000_000).toFixed(8) : 'n/a';
  const vol24hSats = stats.trade_volume_sats;
  const vol24hBch = vol24hSats !== null ? (vol24hSats / 100_000_000).toFixed(8) : 'n/a';
  const vol24hUsd = stats.price_now_usd !== null && vol24hSats !== null
    ? ((vol24hSats / 100_000_000) * stats.price_now_usd / (priceNowSats / 100_000_000)).toFixed(2)
    : 'n/a';
  const tvlBch = stats.tvl_sats !== null ? (stats.tvl_sats / 100_000_000).toFixed(8) : 'n/a';
  const apy = stats.apy_30d_bp !== null ? (stats.apy_30d_bp / 100).toFixed(2) : 'n/a';
  const change24h = stats.change_24h_bp !== null ? (stats.change_24h_bp / 100).toFixed(2) : 'n/a';
  const scoreRank = stats.score_rank !== null ? `#${stats.score_rank}` : 'n/a';

  // 7d stats — the discovery endpoint has price_7d but not trade_volume_7d
  // We note this limitation in the report
  const price7dSats = stats.price_7d_sats;

  // Top pools for this token (for trade-size context)
  let topPools = [];
  try {
    topPools = await fetcher.listPools(resolvedTokenId);
    topPools.sort((a, b) => Number(b.sats) - Number(a.sats)); // descending by BCH size
    topPools = topPools.slice(0, 5);
  } catch (e) {
    log.warn('listPools failed for report', { token_id: resolvedTokenId, err: e?.message });
  }

  const topTradeSizes = topPools.slice(0, 3).map((p) => ({
    sats: p.sats,
    bch: (p.sats / 100_000_000).toFixed(8),
    tokens: String(p.tokens),
  }));

  // Build markdown
  const lines = [
    `# ${sym} — ${stats.name ?? 'Unknown Token'}`,
    '',
    `**Token ID:** \`${resolvedTokenId}\``,
    `**Symbol:** ${sym}`,
    `**Name:** ${stats.name ?? 'n/a'}`,
    `**Decimals:** ${stats.decimals ?? 'n/a'}${stats.decimals_warn ? ` ⚠️ ${stats.decimals_warn}` : ''}`,
    `**Score Rank:** ${scoreRank}`,
    `**Live Pool:** [cauldron.quest](${poolUrl})`,
    '',
    '---',
    '',
    '## Price & Market Data',
    '',
    '| Metric | Value |',
    '|---|---|',
    `| Current Price | ${priceNowSats !== null ? `${Number(priceNowSats).toLocaleString()} sats/token` : 'n/a'} (${priceNowBch} BCH) |`,
    `| Current Price USD | ${stats.price_now_usd !== null ? `$${stats.price_now_usd.toFixed(6)}` : 'n/a'} |`,
    `| 24h Change | ${change24h}% |`,
    `| 7d Price | ${price7dSats !== null ? `${Number(price7dSats).toLocaleString()} sats/token` : 'n/a'} |`,
    '',
    '## Volume & Liquidity',
    '',
    '| Metric | Value |',
    '|---|---|',
    `| 24h Volume | ${vol24hSats !== null ? `${Number(vol24hSats).toLocaleString()} sats` : 'n/a'} (${vol24hBch} BCH) |`,
    `| TVL | ${tvlBch} BCH |`,
    `| 30d APY | ${apy}% |`,
    `| 24h Trade Count | ${stats.trade_count !== null ? Number(stats.trade_count).toLocaleString() : 'n/a'} |`,
    '',
    '## Top 3 Recent Trade Sizes (by BCH size)',
    '',
    topTradeSizes.length > 0
      ? topTradeSizes.map((t, i) => `${i + 1}. **${t.bch} BCH** (${Number(t.tokens).toLocaleString()} tokens)`).join('\n')
      : '_No pool data available._',
    '',
    '---',
    '',
    '## Fundamentals',
    '',
    bcmr?.description
      ? bcmr.description.split('\n').map((l) => `> ${l}`).join('\n')
      : '_No BCMR description available. The token may not have a published authchain commitment._',
    '',
    bcmr?.uris?.icon ? `**Icon:** ${bcmr.uris.icon}` : null,
    bcmr?.uris?.web ? `**Web:** ${bcmr.uris.web}` : null,
    '',
    '---',
    '',
    `*Report generated: ${new Date().toISOString()} via TradeBot data supervisor.*`,
    `*Data source: [Cauldron indexer](https://indexer.riften.net/cauldron) — read-only, no on-chain transactions.*`,
  ];

  const content = lines.filter(Boolean).join('\n');
  const safeFilename = sym.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
  const outPath = `docs/reports/${safeFilename}.md`;
  atomicWrite(outPath, content);
  log.info('report written', { path: outPath, symbol: sym, token_id: resolvedTokenId });

  return { path: outPath, symbol: sym, token_id: resolvedTokenId };
}

// ─── Main ───────────────────────────────────────────────────────────────────

/**
 * @param {string[]} argv
 */
export async function main(argv = process.argv) {
  const { flags, positional } = parseArgs(argv);

  if (flags.help || flags['?']) {
    process.stdout.write(HELP + '\n');
    return 0;
  }

  const cmd = flags['list-pools'] !== undefined
    ? 'list-pools'
    : flags['token-stats']
      ? 'token-stats'
      : flags['snapshot-all']
        ? 'snapshot-all'
        : flags['top20']
          ? 'top20'
          : flags['report']
            ? 'report'
            : null;

  if (!cmd) {
    process.stderr.write('Error: no command specified. Run with --help.\n');
    return 1;
  }

  try {
    switch (cmd) {
      case 'list-pools': {
        const tokenId = typeof flags['list-pools'] === 'string' ? flags['list-pools'] : positional[0] || undefined;
        await cmdListPools(tokenId, {
          json: !!flags.json,
          out: typeof flags['list-pools'] === 'string' ? undefined : flags.out,
        });
        break;
      }
      case 'token-stats': {
        const id = positional[0] || String(flags['token-stats']);
        if (!id) {
          process.stderr.write('Error: --token-stats requires <id-or-symbol>\n');
          return 1;
        }
        await cmdTokenStats(id, { json: !!flags.json, out: flags.out });
        break;
      }
      case 'snapshot-all': {
        await cmdSnapshotAll({ date: flags.date || undefined });
        break;
      }
      case 'top20': {
        const result = await cmdTop20();
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        break;
      }
      case 'report': {
        const symOrId = positional[0] || String(flags.report);
        if (!symOrId) {
          process.stderr.write('Error: --report requires <symbol-or-id>\n');
          return 1;
        }
        const result = await cmdReport(symOrId);
        process.stdout.write(`Report written: ${result.path}\n`);
        break;
      }
      default:
        process.stderr.write(`Error: unknown command "${cmd}"\n`);
        return 1;
    }
  } catch (err) {
    if (err instanceof IndexerError) {
      log.error('indexer error', {
        name: err.name,
        url: err.url,
        message: err.message,
        cause: err.cause?.message,
      });
      process.stderr.write(`Indexer error (${err.name}): ${err.message}\n`);
      if (err.url) process.stderr.write(`  URL: ${err.url}\n`);
      return 1;
    }
    if (err instanceof TypeError) {
      log.error('usage error', { message: err.message });
      process.stderr.write(`Usage error: ${err.message}\n`);
      return 1;
    }
    log.error('unexpected error', { err });
    process.stderr.write(`Unexpected error: ${err?.message ?? err}\n`);
    return 1;
  }

  return 0;
}

// Direct invocation
const isDirect = import.meta.url === `file://${process.argv[1]}` ||
                 process.argv[1]?.endsWith('pull-data.mjs');
if (isDirect) {
  main(process.argv).then((rc) => process.exit(rc));
}
