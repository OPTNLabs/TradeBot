#!/usr/bin/env node
// src/strategy/ranker.mjs
//
// Take a flat list of `PoolStats` and produce the bot's daily trading
// shortlist — the top-K pools most likely to be profitably tradeable
// for our tiny wallet. Pure functions; no I/O; no logger; no globals.
//
// Design rules (also see docs/ARCHITECTURE.md §5):
//   1. Pure. The trader loop imports this and threads `scoringConfig`
//      in from `config/default.json` — the ranker NEVER reaches into
//      a global config object.
//   2. Composable. We layer four filters on top of `scorePools`:
//        a. score     (drop below `min_score`)
//        b. age       (drop pools newer than `max_pool_age_days` —
//                      brand-new pools are wash-trade / seed-swap
//                      risk per T37; see `filterByMaxAge` JSDoc)
//        c. dedup     (collapse pools that share a token_id; keep the
//                      higher-scoring one)
//        d. topK      (sort desc by score, slice to `top_k_candidates`,
//                      attach 1-indexed `rank`)
//      Each filter is exported standalone so tests can exercise them
//      independently and so future code (T13 entry.mjs) can pull just
//      the filter it needs.
//   3. Deterministic. The output order is fully reproducible given
//      the same inputs: score desc → token_id asc as the tiebreaker.
//      This matters for the dashboard's "why did the bot pick this
//      over that?" audit trail.
//   4. Honest about missing evidence. The pool-age field is optional
//      on `PoolStats` because the indexer doesn't expose it today.
//      When it's absent we skip the age filter (and emit a
//      `notes[]` entry) rather than rejecting pools we can't yet
//      age-stamp. This is the same "missing evidence ≠ zero" rule
//      the scoring engine follows.
//   5. The output `reasoning` object is what gets stamped onto a
//      `Position` (see ARCHITECTURE.md §5.1) — it's the audit
//      record the PORTFOLIO view reads to explain an open trade.
//
// Origin: original code for TradeBot. ARCHITECTURE.md §3 places this
// module on the pure layer; the trader loop imports it next.

import {
  DEFAULT_SCORING_CONFIG,
  resolveScoringConfig,
  scorePools,
} from './scoring.mjs';
import { isValidTokenId } from '../data/types.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Defaults
// ─────────────────────────────────────────────────────────────────────

/**
 * Defaults that mirror `config/default.json` → `scoring` for the
 * small-balance-startup preset. The actual config wins when the
 * caller passes something; these only apply on null/garbage input.
 *
 * `max_pool_age_days` defaults to 7 (T37) — pools whose oldest
 * active pool is younger than this many days are dropped
 * (wash-trade / seed-swap / rug-pull risk on freshly-launched
 * tokens). The filter is a SOFT gate: if the indexer doesn't expose
 * a `first_seen_ts_ms` on a pool, we skip the filter rather than
 * rejecting the pool we can't yet age-stamp (see `poolAgeDays`
 * below).
 */
export const DEFAULT_RANKER_CONFIG = Object.freeze({
  ...DEFAULT_SCORING_CONFIG,
  max_pool_age_days: 7,
  top_k_candidates: 3,
});

/**
 * Coerce an input to a ranker config. Falls back to defaults on bad
 * input. We start from `resolveScoringConfig` (so the same scoring
 * knobs compose) and then layer on the ranker-specific ones.
 *
 * @param {Object|undefined|null} input
 * @returns {Object}
 */
export function resolveRankerConfig(input) {
  const base = resolveScoringConfig(input);
  const out = { ...base };
  if (input && typeof input === 'object') {
    if (input.max_pool_age_days !== undefined && Number.isFinite(Number(input.max_pool_age_days))) {
      out.max_pool_age_days = Number(input.max_pool_age_days);
    }
    if (input.top_k_candidates !== undefined && Number.isFinite(Number(input.top_k_candidates))) {
      out.top_k_candidates = Math.max(1, Math.floor(Number(input.top_k_candidates)));
    }
  }
  if (!Number.isFinite(out.max_pool_age_days) || out.max_pool_age_days < 0) {
    out.max_pool_age_days = DEFAULT_RANKER_CONFIG.max_pool_age_days;
  }
  if (!Number.isFinite(out.top_k_candidates) || out.top_k_candidates < 1) {
    out.top_k_candidates = DEFAULT_RANKER_CONFIG.top_k_candidates;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
//  Age helper (pure)
// ─────────────────────────────────────────────────────────────────────

/**
 * Pull the most-plausible "when did this pool first show up?" field
 * off a stats record. The indexer doesn't expose this consistently
 * today — when it does (see open question in ARCHITECTURE.md §10),
 * the field will be `first_seen_ts_ms` or `created_at_ts_ms`.
 *
 * Returns `null` when no timestamp is present (treated as "we don't
 * know yet", NOT as 0 — the caller should skip the age filter
 * rather than reject).
 *
 * Order of preference (first match wins):
 *   1. `first_seen_ts_ms`  (preferred — canonical name)
 *   2. `created_at_ts_ms`  (alias for indexers that use created_at)
 *   3. `first_seen` / `created_at` (ISO-8601 strings → Date.parse)
 *
 * @param {Record<string, unknown>} stats
 * @returns {number|null}  ms since epoch, or null
 */
export function poolFirstSeenMs(stats) {
  if (!stats || typeof stats !== 'object') return null;
  const directCandidates = ['first_seen_ts_ms', 'created_at_ts_ms'];
  for (const k of directCandidates) {
    const v = /** @type {Record<string, unknown>} */ (stats)[k];
    if (v === null || v === undefined) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const stringCandidates = ['first_seen', 'created_at'];
  for (const k of stringCandidates) {
    const v = /** @type {Record<string, unknown>} */ (stats)[k];
    if (typeof v !== 'string' || !v) continue;
    const parsed = Date.parse(v);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

/**
 * Compute the age of a pool in days (fractional). Returns `null`
 * when no first-seen timestamp is available — the caller treats
 * `null` as "no age evidence; skip the age filter".
 *
 * Pure. Exported for tests.
 *
 * @param {Record<string, unknown>} stats
 * @param {number} nowMs
 * @returns {number|null}
 */
export function poolAgeDays(stats, nowMs) {
  const firstSeen = poolFirstSeenMs(stats);
  if (firstSeen === null) return null;
  // Invalid `now` is also "missing evidence" — caller bug or a
  // caller that didn't pass Date.now(). Either way we can't compute
  // an age, so return null rather than 0.
  if (!Number.isFinite(nowMs)) return null;
  if (nowMs <= firstSeen) return 0;
  const MS_PER_DAY = 86_400_000;
  return (nowMs - firstSeen) / MS_PER_DAY;
}

// ─────────────────────────────────────────────────────────────────────
//  Filters (pure, exported for tests + future reuse)
// ─────────────────────────────────────────────────────────────────────

/**
 * Drop scored records whose `score` is below `cfg.min_score`. The
 * scoring engine already zeroes out ineligible pools, so this filter
 * mostly exists for the case where a config has tightened the floor
 * since the last score was computed (re-ranking an in-memory list
 * with a new config is cheaper than re-scoring).
 *
 * Records with `eligible === false` are also dropped — there's no
 * point in feeding them to the entry layer.
 *
 * Pure. Does NOT mutate inputs.
 *
 * @param {Array<Object>} scored
 * @param {Object} cfg
 * @returns {Array<Object>}
 */
export function filterByMinScore(scored, cfg) {
  if (!Array.isArray(scored)) return [];
  const minScore = Number(cfg?.min_score);
  if (!Number.isFinite(minScore)) return scored.slice();
  return scored.filter((s) => {
    if (!s || typeof s !== 'object') return false;
    if (s.eligible === false) return false;
    const score = Number(s.score);
    if (!Number.isFinite(score)) return false;
    return score >= minScore;
  });
}

/**
 * Drop pools NEWER than `cfg.max_pool_age_days` — freshly-launched
 * pools carry wash-trade / seed-swap / rug-pull risk per T37. The
 * knob was historically mis-wired (it dropped pools OLDER than the
 * cap) which would have rejected ~98% of tokens against the
 * Cauldron indexer's `first_pool_ts` distribution; T37 flips the
 * semantic to match the docs/SETTINGS.md description
 * ("Drop pools newer than this — too little history to score
 * reliably") and the operator's stated intent.
 *
 * Pools with no `first_seen_ts_ms` (the indexer didn't expose it)
 * PASS through — see the "missing evidence" rule in the module
 * header. Records that fail the age filter have their `reasons[]`
 * appended with `age:Xd/Yd` so the dashboard can show "rejected:
 * pool is 2d old (cap 7d)" rather than silently dropping them.
 *
 * Pure.
 *
 * @param {Array<Object>} scored
 * @param {Object} cfg
 * @param {number} nowMs
 * @returns {Array<Object>}
 */
export function filterByMaxAge(scored, cfg, nowMs) {
  if (!Array.isArray(scored)) return [];
  const maxAgeDays = Number(cfg?.max_pool_age_days);
  if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) return scored.slice();
  if (!Number.isFinite(nowMs)) return scored.slice();
  return scored.filter((s) => {
    if (!s || typeof s !== 'object') return true;
    const stats = s.stats ?? null;
    const age = poolAgeDays(stats, nowMs);
    if (age === null) return true; // missing evidence — keep
    if (age >= maxAgeDays) return true;
    // Reject. Annotate the reasons array so the dashboard can show
    // why this pool was dropped.
    if (Array.isArray(s.reasons)) {
      s.reasons.push(`age:${age.toFixed(2)}d<${maxAgeDays}d`);
    } else {
      s.reasons = [`age:${age.toFixed(2)}d<${maxAgeDays}d`];
    }
    return false;
  });
}

/**
 * Collapse duplicate `token_id` entries by keeping the highest-scoring
 * record. Ties broken by token_id ascending (deterministic).
 *
 * The indexer can surface the same token twice in `list_cached` if
 * there's both an "active pool" view and a "top by TVL" view, etc.
 * Dedup here keeps `rank` 1-indexed and per-token, which is what
 * the entry layer expects.
 *
 * Pure. Does NOT mutate inputs.
 *
 * @param {Array<Object>} scored
 * @returns {Array<Object>}
 */
export function dedupByTokenId(scored) {
  if (!Array.isArray(scored)) return [];
  /** @type {Map<string, Object>} */
  const bestByToken = new Map();
  for (const s of scored) {
    if (!s || typeof s !== 'object') continue;
    const tid = typeof s.token_id === 'string' ? s.token_id : '';
    if (!tid) continue;
    const cur = bestByToken.get(tid);
    if (!cur) { bestByToken.set(tid, s); continue; }
    // Higher score wins; ties → earlier token_id wins (alphabetical).
    const curScore = Number(cur.score) || 0;
    const newScore = Number(s.score) || 0;
    if (newScore > curScore || (newScore === curScore && tid < (cur.token_id || ''))) {
      bestByToken.set(tid, s);
    }
  }
  return Array.from(bestByToken.values());
}

/**
 * Sort scored records by `score` desc, with `token_id` asc as the
 * deterministic tiebreaker. Pure; does NOT mutate inputs (returns
 * a fresh array).
 *
 * Why not mutating?  The same scored list might be filtered by
 * multiple downstream stages; an in-place sort would surprise
 * callers that pass in their own array.
 *
 * @param {Array<Object>} scored
 * @returns {Array<Object>}
 */
export function sortByScore(scored) {
  if (!Array.isArray(scored)) return [];
  return scored.slice().sort((a, b) => {
    const sa = Number(a?.score) || 0;
    const sb = Number(b?.score) || 0;
    if (sb !== sa) return sb - sa; // descending
    const ta = typeof a?.token_id === 'string' ? a.token_id : '';
    const tb = typeof b?.token_id === 'string' ? b.token_id : '';
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return 0;
  });
}

/**
 * Take the top-K records from a sorted list and attach a 1-indexed
 * `rank` to each. Pure.
 *
 * `k < 1` returns an empty list. `k > scored.length` returns as many
 * as we have (rank stops at `scored.length`).
 *
 * @param {Array<Object>} sorted
 * @param {number} k
 * @returns {Array<Object>}
 */
export function takeTopK(sorted, k) {
  if (!Array.isArray(sorted)) return [];
  const safeK = (Number.isFinite(Number(k)) && Number(k) >= 1) ? Math.floor(Number(k)) : 0;
  if (safeK <= 0) return [];
  return sorted.slice(0, safeK).map((s, i) => ({ ...s, rank: i + 1 }));
}

// ─────────────────────────────────────────────────────────────────────
//  Main entry point
// ─────────────────────────────────────────────────────────────────────

/**
 * Score → filter → dedup → sort → top-K. The single entry the
 * trader loop calls each tick.
 *
 * Output shape (per candidate):
 *   {
 *     token_id:    string,
 *     score:       number in [0, 1],
 *     eligible:    boolean,
 *     reasons:     string[],    // hard-gate rejection reasons; empty if eligible
 *     rank:        number,      // 1-indexed; only on the top-K list
 *     topK:        number,      // total candidates selected (echo of cfg.top_k_candidates)
 *     stats:       PoolStats,   // the original record (so downstream
 *                               //   can re-quote without re-fetching)
 *     breakdown:   Object,      // from scorePool — full per-feature detail
 *     reasoning: {
 *       ts,                    // ms since epoch when the rank was computed
 *       eligible_for_trade,    // shorthand copy of `eligible`
 *       score,                 // shorthand copy of `score`
 *       rank,                  // shorthand copy of `rank`
 *       topK,                  // shorthand copy of `topK`
 *       passed_filters: string[],  // e.g. ['min_score', 'max_age', 'dedup', 'topk']
 *       conditions: { min_score, max_age_days, top_k_candidates },
 *     },
 *     notes: string[],          // informational flags, e.g. age-filter skipped
 *   }
 *
 * The trader loop (T14) consumes `candidates[].rank` as input to
 * `entry.mjs.shouldEnter(...)` — a `rank > 0` is required for entry.
 *
 * @param {Array<import('../data/types.mjs').PoolStats>} statsList
 * @param {Object} [rankerConfig]
 * @param {Object} [opts]
 * @param {number} [opts.nowMs]       ms since epoch (defaults to Date.now)
 * @param {number} [opts.fee_rate_bps]  overrides cfg.fee_rate_bps per-call
 * @returns {{
 *   candidates: Array<Object>,
 *   meta: {
 *     input_count: number,
 *     after_score_filter: number,
 *     after_age_filter: number,
 *     after_dedup: number,
 *     returned: number,
 *     now_ms: number,
 *     notes: string[],
 *   },
 * }}
 */
export function rankPools(statsList, rankerConfig = DEFAULT_RANKER_CONFIG, opts = {}) {
  const cfg = resolveRankerConfig(rankerConfig);
  const nowMs = (opts.nowMs !== undefined && Number.isFinite(Number(opts.nowMs)))
    ? Number(opts.nowMs)
    : Date.now();
  const feeRateBps = (opts.fee_rate_bps !== undefined && Number.isFinite(Number(opts.fee_rate_bps)))
    ? Number(opts.fee_rate_bps)
    : cfg.fee_rate_bps;

  const inputCount = Array.isArray(statsList) ? statsList.length : 0;
  const metaNotes = [];

  // 1. Score every pool (delegated to scoring.mjs). Output rows
  //    carry `token_id` because scorePools threads it through.
  let scored = scorePools(statsList, cfg, { fee_rate_bps: feeRateBps });
  // Preserve a copy of the source record so the entry layer can
  // re-quote without re-fetching.
  const statsByTokenId = new Map();
  if (Array.isArray(statsList)) {
    for (const s of statsList) {
      if (s && typeof s === 'object' && typeof s.token_id === 'string') {
        statsByTokenId.set(s.token_id.toLowerCase(), s);
      }
    }
  }
  for (const row of scored) {
    if (row && typeof row === 'object' && typeof row.token_id === 'string') {
      row.stats = statsByTokenId.get(row.token_id.toLowerCase()) ?? row;
    }
  }

  // 2. Drop pools below min_score / ineligible.
  const beforeScoreFilter = scored.length;
  scored = filterByMinScore(scored, cfg);
  const afterScoreFilter = scored.length;

  // 3. Drop pools older than max_pool_age_days. If NO pool in the
  //    input exposes a first-seen timestamp, the filter is a no-op
  //    and we record that in `meta.notes` so the dashboard can show
  //    "age filter not applied (indexer doesn't expose timestamps)".
  const anyWithAge = scored.some((s) => poolFirstSeenMs(s.stats ?? {}) !== null);
  if (!anyWithAge && inputCount > 0) {
    metaNotes.push('age_filter_skipped:no_first_seen_ts_in_indexer');
  }
  const beforeAgeFilter = scored.length;
  scored = filterByMaxAge(scored, cfg, nowMs);
  const afterAgeFilter = scored.length;

  // 4. Dedup by token_id (keep highest-scoring).
  const beforeDedup = scored.length;
  scored = dedupByTokenId(scored);
  const afterDedup = scored.length;

  // 5. Sort by score desc (token_id asc tiebreaker).
  const sorted = sortByScore(scored);

  // 6. Top-K + 1-indexed rank.
  const candidates = takeTopK(sorted, cfg.top_k_candidates);

  // 7. Attach the reasoning blob the trader loop stamps onto positions.
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;
    const tid = typeof c.token_id === 'string' ? c.token_id : '';
    c.topK = cfg.top_k_candidates;
    c.reasoning = {
      ts: nowMs,
      eligible_for_trade: c.eligible === true,
      score: c.score,
      rank: c.rank,
      topK: cfg.top_k_candidates,
      passed_filters: ['min_score', 'max_age', 'dedup', 'topk'],
      conditions: {
        min_score: cfg.min_score,
        max_age_days: cfg.max_pool_age_days,
        top_k_candidates: cfg.top_k_candidates,
      },
      token_id: tid,
    };
    c.notes = [];
    if (!isValidTokenId(tid)) {
      c.notes.push('token_id_format_invalid');
    }
    if (c.breakdown && Array.isArray(c.breakdown.missing) && c.breakdown.missing.length > 0) {
      c.notes.push(`scored_with_missing_features:${c.breakdown.missing.join(',')}`);
    }
    if (poolFirstSeenMs(c.stats ?? {}) === null) {
      c.notes.push('age_unknown');
    }
  }

  return {
    candidates,
    meta: {
      input_count: inputCount,
      after_score_filter: afterScoreFilter,
      after_age_filter: afterAgeFilter,
      after_dedup: afterDedup,
      returned: candidates.length,
      before_score_filter: beforeScoreFilter,
      before_age_filter: beforeAgeFilter,
      before_dedup: beforeDedup,
      now_ms: nowMs,
      notes: metaNotes,
    },
  };
}
