#!/usr/bin/env node
// src/feature-ideas/researcher.mjs
//
// Pure logic for the feature-ideas research cron. Given the
// catalog + the current on-disk store, returns the ideas that
// SHOULD be appended. All I/O is in the caller (`feature_researcher.mjs`).
//
// Behavior rules:
//
//   1. **Idempotency / dedupe.** Each template generates ideas
//      keyed by `template_id`. Once a template has been used to
//      produce ANY idea in the store (regardless of status), it's
//      considered "spent" and won't be picked again. This means:
//        - approved ideas that the supervisor later marks shipped
//          still keep their template_id "spent" — the catalog is a
//          one-shot pump.
//        - rejected ideas also keep the template spent (otherwise
//          the cron would re-propose every idea the operator
//          rejected last week).
//      The supervisor can grow the catalog over time by appending
//      new templates — no schema bump required.
//
//   2. **Bounded output.** A run produces at most `opts.maxPerRun`
//      ideas (default 3). Even if 50 templates are available, the
//      cron only emits a handful so the operator doesn't get
//      drowned.
//
//   3. **Randomized selection.** Templates are shuffled (Fisher-
//      Yates with the supplied PRNG) so subsequent cron runs
//      surface different ideas. The shuffle is seeded so tests
//      are deterministic.
//
//   4. **Deterministic IDs.** The idea id is
//      `idea_<template_id>_<YYYYMMDD>` so re-running on the same
//      day yields the same ids (which means addIdeas() skips
//      them — idempotent).
//
//   5. **Pure.** No I/O. No module-scope state. Side effects only
//      via injected `now` + `random` dependencies.

import { RESEARCH_CATALOG } from './research-catalog.mjs';

/**
 * Generate the on-disk idea id from a template + a date. Pure.
 *
 * @param {string} templateId
 * @param {Date} [now]
 * @returns {string}
 */
export function ideaIdForTemplate(templateId, now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `idea_${templateId}_${y}${m}${d}`;
}

/**
 * Compute the set of template_ids already represented in the
 * store's ideas list. Used for dedupe. Pure.
 *
 * @param {Array<{category_tags?: string[]}>} existingIdeas
 * @returns {Set<string>}
 */
export function usedTemplateIds(existingIdeas) {
  const out = new Set();
  if (!Array.isArray(existingIdeas)) return out;
  for (const idea of existingIdeas) {
    if (!idea || typeof idea !== 'object') continue;
    const tags = Array.isArray(idea.category_tags) ? idea.category_tags : [];
    // Catalog-generated ideas have `template:<id>` in their
    // category_tags. The seed ideas use literal tags without the
    // `template:` prefix.
    for (const tag of tags) {
      if (typeof tag === 'string' && tag.startsWith('template:')) {
        out.add(tag.slice('template:'.length));
      }
    }
  }
  return out;
}

/**
 * Fisher-Yates shuffle using the supplied PRNG. Returns a NEW
 * array (does not mutate the input). Pure.
 *
 * @template T
 * @param {ReadonlyArray<T>} arr
 * @param {() => number} random   a function returning [0, 1)
 * @returns {T[]}
 */
export function shuffle(arr, random) {
  const a = Array.from(arr);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}

/**
 * Pick the ideas to append, given the catalog + the store's
 * current state. Pure.
 *
 * @param {Object} opts
 * @param {ReadonlyArray<Object>} opts.catalog    pass `RESEARCH_CATALOG` directly
 * @param {Array<Object>} opts.existingIdeas     the store's current ideas array
 * @param {number} [opts.maxPerRun=3]
 * @param {Date} [opts.now]
 * @param {() => number} [opts.random]           default `Math.random` (tests inject a seeded PRNG)
 * @returns {{
 *   toAppend: Array<{
 *     id: string,
 *     title: string,
 *     category: string,
 *     rationale: string,
 *     evidence: string,
 *     effort: 'S'|'M'|'L',
 *     impact: 'low'|'medium'|'high',
 *     category_tags: string[],
 *   }>,
 *   available: number,
 *   spent: number,
 *   skipped: number,
 * }}
 */
export function pickIdeas(opts) {
  if (!opts || typeof opts !== 'object') {
    throw new Error('pickIdeas: opts required');
  }
  if (!Array.isArray(opts.catalog)) {
    throw new Error('pickIdeas: opts.catalog must be an array');
  }
  const maxPerRun = (typeof opts.maxPerRun === 'number' && opts.maxPerRun > 0)
    ? Math.floor(opts.maxPerRun)
    : 3;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const random = (typeof opts.random === 'function') ? opts.random : Math.random;
  const existing = Array.isArray(opts.existingIdeas) ? opts.existingIdeas : [];

  const spent = usedTemplateIds(existing);
  const available = opts.catalog.filter((t) => !spent.has(t.template_id));

  const shuffled = shuffle(available, random);
  const toAppend = shuffled.slice(0, maxPerRun).map((t) => ({
    id: ideaIdForTemplate(t.template_id, now),
    title: t.title,
    category: t.category,
    rationale: t.rationale_template,
    evidence: t.evidence_template,
    effort: t.effort,
    impact: t.impact,
    // `template:<id>` is the dedupe key. Tags preserve provenance.
    category_tags: ['template:' + t.template_id, ...t.category_tags],
  }));

  return {
    toAppend,
    available: available.length,
    spent: spent.size,
    skipped: Math.max(0, available.length - toAppend.length),
  };
}

/**
 * Convenience: pick + flatten to just the list of new ideas.
 *
 * @param {Object} opts
 * @returns {Array<Object>}
 */
export function runResearchPass(opts) {
  return pickIdeas(opts).toAppend;
}

/**
 * Decide whether the cron should run NOW or wait. Pure.
 *
 * The cron is rate-limited to `opts.minIntervalHours` (default 12)
 * between runs to avoid spamming the dashboard if the cron is
 * misconfigured. Returns `false` if last_research_at was within
 * the window.
 *
 * @param {Object} opts
 * @param {string|null} opts.lastResearchAt
 * @param {Date} [opts.now]
 * @param {number} [opts.minIntervalHours=12]
 * @returns {{ shouldRun: boolean, hoursSinceLastRun: number|null }}
 */
export function shouldRunResearch(opts) {
  if (!opts || typeof opts !== 'object') {
    throw new Error('shouldRunResearch: opts required');
  }
  const now = opts.now instanceof Date ? opts.now : new Date();
  const minHours = (typeof opts.minIntervalHours === 'number' && opts.minIntervalHours > 0)
    ? opts.minIntervalHours
    : 12;
  if (typeof opts.lastResearchAt !== 'string' || opts.lastResearchAt.length === 0) {
    return { shouldRun: true, hoursSinceLastRun: null };
  }
  const last = new Date(opts.lastResearchAt);
  if (!Number.isFinite(last.getTime())) {
    return { shouldRun: true, hoursSinceLastRun: null };
  }
  const hoursSince = (now.getTime() - last.getTime()) / (1000 * 60 * 60);
  return {
    shouldRun: hoursSince >= minHours,
    hoursSinceLastRun: hoursSince,
  };
}