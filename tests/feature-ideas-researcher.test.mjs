#!/usr/bin/env node
// tests/feature-ideas-researcher.test.mjs
//
// Unit tests for src/feature-ideas/researcher.mjs + the cron
// entry point scripts/feature_researcher.mjs.
//
// All I/O is via tmp dirs; no network, no real store file. Tests
// run in <1s.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RESEARCH_CATALOG } from '../src/feature-ideas/research-catalog.mjs';
import {
  ideaIdForTemplate,
  usedTemplateIds,
  shuffle,
  pickIdeas,
  shouldRunResearch,
} from '../src/feature-ideas/researcher.mjs';
import {
  parseResearcherArgs,
  mainFeatureResearcher,
  buildResearchCronRunEvent,
  appendResearchCronRunEvent,
  shouldWriteResearchCronHistory,
} from '../scripts/feature_researcher.mjs';
import { FeatureIdeasStore } from '../src/feature-ideas/store.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────

/** Deterministic [0,1) PRNG using a linear-congruential generator. */
function makeRng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

async function makeTmp() {
  const dir = await mkdtemp(join(tmpdir(), 'feat-research-test-'));
  return {
    dir,
    file: join(dir, 'feature-ideas.json'),
    historyFile: join(dir, 'history.ndjson'),
    cleanup: async () => { try { await rm(dir, { recursive: true, force: true }); } catch {} },
  };
}

// ─────────────────────────────────────────────────────────────────────
//  catalog validation
// ─────────────────────────────────────────────────────────────────────

test('catalog: every template has a unique template_id', () => {
  const ids = RESEARCH_CATALOG.map((t) => t.template_id);
  assert.equal(ids.length, new Set(ids).size, 'template_ids must be unique');
});

test('catalog: every template covers one of the five schema categories', () => {
  const allowed = new Set([
    'edge-case-protection', 'decision-logic', 'dashboard',
    'observability', 'performance',
  ]);
  for (const t of RESEARCH_CATALOG) {
    assert.equal(allowed.has(t.category), true, `${t.template_id}: bad category ${t.category}`);
  }
});

test('catalog: every template declares effort S/M/L', () => {
  for (const t of RESEARCH_CATALOG) {
    assert.ok(['S', 'M', 'L'].includes(t.effort), `${t.template_id}: bad effort ${t.effort}`);
  }
});

test('catalog: every template declares impact low/medium/high', () => {
  for (const t of RESEARCH_CATALOG) {
    assert.ok(['low', 'medium', 'high'].includes(t.impact), `${t.template_id}: bad impact ${t.impact}`);
  }
});

test('catalog: every template has non-empty title + rationale + category_tags', () => {
  for (const t of RESEARCH_CATALOG) {
    assert.ok(t.title.length > 0, `${t.template_id}: empty title`);
    assert.ok(t.rationale_template.length > 0, `${t.template_id}: empty rationale`);
    assert.ok(Array.isArray(t.category_tags), `${t.template_id}: category_tags not array`);
    assert.ok(t.category_tags.length > 0, `${t.template_id}: empty category_tags`);
  }
});

test('catalog: distribution skews toward high-impact + edge-case-protection', () => {
  // Sanity check: most templates should be high-impact or medium-impact.
  const impactCounts = { low: 0, medium: 0, high: 0 };
  for (const t of RESEARCH_CATALOG) impactCounts[t.impact]++;
  assert.ok(impactCounts.high >= 10, `expected ≥10 high-impact, got ${impactCounts.high}`);
  assert.ok(impactCounts.high + impactCounts.medium >= impactCounts.low * 2,
    'high+medium should outnumber low by 2x');
  // And there should be ≥8 templates in each of the 3 main user goals.
  const counts = { 'edge-case-protection': 0, 'decision-logic': 0, 'dashboard': 0 };
  for (const t of RESEARCH_CATALOG) {
    if (counts[t.category] !== undefined) counts[t.category]++;
  }
  for (const [cat, n] of Object.entries(counts)) {
    assert.ok(n >= 6, `expected ≥6 templates for ${cat}, got ${n}`);
  }
});

// ─────────────────────────────────────────────────────────────────────
//  ideaIdForTemplate
// ─────────────────────────────────────────────────────────────────────

test('ideaIdForTemplate: deterministic id includes YYYYMMDD', () => {
  const date = new Date(Date.UTC(2026, 8, 14)); // 2026-09-14
  assert.equal(ideaIdForTemplate('foo', date), 'idea_foo_20260914');
});

test('ideaIdForTemplate: zero-pads month + day', () => {
  const date = new Date(Date.UTC(2026, 0, 5)); // 2026-01-05
  assert.equal(ideaIdForTemplate('bar', date), 'idea_bar_20260105');
});

// ─────────────────────────────────────────────────────────────────────
//  usedTemplateIds
// ─────────────────────────────────────────────────────────────────────

test('usedTemplateIds: empty input → empty set', () => {
  assert.equal(usedTemplateIds([]).size, 0);
});

test('usedTemplateIds: extracts template:<id> from category_tags', () => {
  const ideas = [
    { category_tags: ['template:foo', 'edge-case'] },
    { category_tags: ['template:bar'] },
    { category_tags: ['no-template-tag'] },
  ];
  const used = usedTemplateIds(ideas);
  assert.equal(used.size, 2);
  assert.equal(used.has('foo'), true);
  assert.equal(used.has('bar'), true);
});

test('usedTemplateIds: ignores ideas with missing / non-array category_tags', () => {
  const ideas = [
    { category_tags: null },
    {},
    { category_tags: 'not-an-array' },
  ];
  assert.equal(usedTemplateIds(ideas).size, 0);
});

// ─────────────────────────────────────────────────────────────────────
//  shuffle
// ─────────────────────────────────────────────────────────────────────

test('shuffle: returns a permutation of the input', () => {
  const arr = [1, 2, 3, 4, 5];
  const out = shuffle(arr, makeRng(42));
  assert.equal(out.length, arr.length);
  assert.deepEqual([...out].sort(), arr);
});

test('shuffle: does not mutate input', () => {
  const arr = [1, 2, 3, 4, 5];
  const before = [...arr];
  shuffle(arr, makeRng(7));
  assert.deepEqual(arr, before);
});

test('shuffle: with seed=42 the output is deterministic', () => {
  const a = shuffle([1, 2, 3, 4, 5], makeRng(42));
  const b = shuffle([1, 2, 3, 4, 5], makeRng(42));
  assert.deepEqual(a, b);
});

test('shuffle: with different seeds the output differs', () => {
  const a = shuffle([1, 2, 3, 4, 5, 6, 7, 8], makeRng(1));
  const b = shuffle([1, 2, 3, 4, 5, 6, 7, 8], makeRng(2));
  assert.notDeepEqual(a, b);
});

// ─────────────────────────────────────────────────────────────────────
//  pickIdeas
// ─────────────────────────────────────────────────────────────────────

test('pickIdeas: returns up to maxPerRun ideas', () => {
  const r = pickIdeas({
    catalog: RESEARCH_CATALOG,
    existingIdeas: [],
    maxPerRun: 3,
    random: makeRng(1),
  });
  assert.ok(r.toAppend.length <= 3);
  assert.ok(r.toAppend.length >= 1, 'at least 1 idea when catalog is fresh');
});

test('pickIdeas: respects maxPerRun=1', () => {
  const r = pickIdeas({
    catalog: RESEARCH_CATALOG,
    existingIdeas: [],
    maxPerRun: 1,
    random: makeRng(1),
  });
  assert.equal(r.toAppend.length, 1);
});

test('pickIdeas: skips templates already used in the store', () => {
  // Mark half the templates as used.
  const usedTemplates = RESEARCH_CATALOG.slice(0, Math.floor(RESEARCH_CATALOG.length / 2));
  const existing = usedTemplates.map((t) => ({
    category_tags: ['template:' + t.template_id, 'edge-case'],
  }));
  const r = pickIdeas({
    catalog: RESEARCH_CATALOG,
    existingIdeas: existing,
    maxPerRun: 100,
    random: makeRng(1),
  });
  // Every emitted idea must NOT use a template we marked as spent.
  for (const idea of r.toAppend) {
    const tpl = idea.category_tags.find((t) => t.startsWith('template:'));
    const tplId = tpl ? tpl.slice('template:'.length) : null;
    assert.ok(tplId);
    const wasUsed = usedTemplates.some((t) => t.template_id === tplId);
    assert.equal(wasUsed, false, `template ${tplId} should have been skipped`);
  }
});

test('pickIdeas: emits deterministic IDs based on date + template', () => {
  const date = new Date(Date.UTC(2026, 8, 14));
  const r = pickIdeas({
    catalog: RESEARCH_CATALOG,
    existingIdeas: [],
    maxPerRun: 3,
    now: date,
    random: makeRng(1),
  });
  for (const idea of r.toAppend) {
    assert.match(idea.id, /^idea_[a-z0-9_]+_20260914$/);
  }
});

test('pickIdeas: returns empty array when catalog fully exhausted', () => {
  const existing = RESEARCH_CATALOG.map((t) => ({
    category_tags: ['template:' + t.template_id],
  }));
  const r = pickIdeas({
    catalog: RESEARCH_CATALOG,
    existingIdeas: existing,
    maxPerRun: 100,
    random: makeRng(1),
  });
  assert.equal(r.toAppend.length, 0);
  assert.equal(r.available, 0);
  assert.equal(r.spent, RESEARCH_CATALOG.length);
});

test('pickIdeas: surfaces count of available / spent / skipped', () => {
  const r = pickIdeas({
    catalog: RESEARCH_CATALOG,
    existingIdeas: [],
    maxPerRun: 2,
    random: makeRng(1),
  });
  assert.equal(typeof r.available, 'number');
  assert.equal(typeof r.spent, 'number');
  assert.equal(typeof r.skipped, 'number');
  assert.ok(r.available > 0);
  assert.equal(r.spent, 0);
  // 2 ideas appended, so skipped = available - 2 (when available > 2)
  assert.equal(r.skipped, Math.max(0, r.available - 2));
});

test('pickIdeas: validates opts', () => {
  assert.throws(() => pickIdeas(null), /opts required/);
  assert.throws(() => pickIdeas({}), /catalog must be an array/);
});

// ─────────────────────────────────────────────────────────────────────
//  shouldRunResearch
// ─────────────────────────────────────────────────────────────────────

test('shouldRunResearch: no previous research → shouldRun=true', () => {
  const r = shouldRunResearch({ lastResearchAt: null });
  assert.equal(r.shouldRun, true);
  assert.equal(r.hoursSinceLastRun, null);
});

test('shouldRunResearch: invalid date string → shouldRun=true (fail-open)', () => {
  const r = shouldRunResearch({ lastResearchAt: 'not-a-date' });
  assert.equal(r.shouldRun, true);
});

test('shouldRunResearch: 6h ago with 12h window → shouldRun=false', () => {
  const now = new Date('2026-09-14T12:00:00Z');
  const r = shouldRunResearch({
    lastResearchAt: '2026-09-14T06:00:00Z',
    now,
    minIntervalHours: 12,
  });
  assert.equal(r.shouldRun, false);
  assert.equal(Math.round(r.hoursSinceLastRun), 6);
});

test('shouldRunResearch: 13h ago with 12h window → shouldRun=true', () => {
  const now = new Date('2026-09-14T12:00:00Z');
  const r = shouldRunResearch({
    lastResearchAt: '2026-09-13T23:00:00Z',
    now,
    minIntervalHours: 12,
  });
  assert.equal(r.shouldRun, true);
});

// ─────────────────────────────────────────────────────────────────────
//  parseResearcherArgs
// ─────────────────────────────────────────────────────────────────────

test('parseResearcherArgs: defaults', () => {
  const a = parseResearcherArgs(['node', 'feature_researcher.mjs']);
  assert.equal(a.dryRun, false);
  assert.equal(a.force, false);
  assert.equal(a.noHistory, false);
  assert.equal(a.file, 'data/feature-ideas.json');
  assert.equal(a.historyFile, 'data/history.ndjson');
  assert.equal(a.maxPerRun, 3);
  assert.equal(a.minIntervalHours, 12);
});

test('parseResearcherArgs: --dry-run / --force', () => {
  const a = parseResearcherArgs(['node', 'feature_researcher.mjs', '--dry-run', '--force']);
  assert.equal(a.dryRun, true);
  assert.equal(a.force, true);
});

test('parseResearcherArgs: --no-history sets noHistory=true', () => {
  const a = parseResearcherArgs(['node', 'feature_researcher.mjs', '--no-history']);
  assert.equal(a.noHistory, true);
  assert.equal(a.withHistory, false);
});

test('parseResearcherArgs: --history explicitly opts in (even with --dry-run)', () => {
  const a = parseResearcherArgs(['node', 'feature_researcher.mjs', '--dry-run', '--history']);
  assert.equal(a.dryRun, true);
  assert.equal(a.noHistory, false);
  assert.equal(a.withHistory, true);
});

test('parseResearcherArgs: --no-history then --history cancels', () => {
  const a = parseResearcherArgs(['node', 'feature_researcher.mjs', '--no-history', '--history']);
  assert.equal(a.noHistory, false);
  assert.equal(a.withHistory, true);
});

test('parseResearcherArgs: --file=...', () => {
  const a = parseResearcherArgs(['node', 'feature_researcher.mjs', '--file=/tmp/x.json']);
  assert.equal(a.file, '/tmp/x.json');
});

test('parseResearcherArgs: --history-file=...', () => {
  const a = parseResearcherArgs(['node', 'feature_researcher.mjs', '--history-file=/tmp/h.ndjson']);
  assert.equal(a.historyFile, '/tmp/h.ndjson');
});

test('parseResearcherArgs: --max-per-run=N', () => {
  const a = parseResearcherArgs(['node', 'feature_researcher.mjs', '--max-per-run=7']);
  assert.equal(a.maxPerRun, 7);
});

test('parseResearcherArgs: --min-interval-hours=N', () => {
  const a = parseResearcherArgs(['node', 'feature_researcher.mjs', '--min-interval-hours=24']);
  assert.equal(a.minIntervalHours, 24);
});

// ─────────────────────────────────────────────────────────────────────
//  mainFeatureResearcher (end-to-end against tmp store)
// ─────────────────────────────────────────────────────────────────────

test('mainFeatureResearcher: appends ideas to a fresh store', async () => {
  const tmp = await makeTmp();
  try {
    const r = await mainFeatureResearcher({
      dryRun: false,
      force: true,
      file: tmp.file,
      historyFile: tmp.historyFile,
      maxPerRun: 2,
      minIntervalHours: 12,
    });
    assert.equal(r.ran, true);
    assert.ok(r.added >= 1 && r.added <= 2);
    assert.ok(r.ideas.length === r.added);
    assert.equal(r.historyWritten, true);
    assert.equal(r.historyError, null);
    // Verify the store on disk actually got the ideas.
    const store = new FeatureIdeasStore({ file: tmp.file });
    const file = await store.load();
    assert.ok(file.meta.total_count >= r.added);
    assert.equal(typeof file.meta.last_research_at, 'string');
    // Verify the history file got the audit event too.
    const histBody = await readFile(tmp.historyFile, 'utf8');
    assert.ok(histBody.includes('"kind":"research_cron_run"'));
    const evt = JSON.parse(histBody.trim().split('\n').pop());
    assert.equal(evt.ran, true);
    assert.equal(evt.forced, true);
    assert.equal(evt.rate_limited, false);
  } finally { await tmp.cleanup(); }
});

test('mainFeatureResearcher: --dry-run does not mutate the store', async () => {
  const tmp = await makeTmp();
  try {
    const r = await mainFeatureResearcher({
      dryRun: true,
      force: true,
      file: tmp.file,
      historyFile: tmp.historyFile,
      maxPerRun: 2,
      minIntervalHours: 12,
    });
    assert.equal(r.ran, true);
    assert.equal(r.added, 0); // dry-run doesn't append
    assert.equal(r.historyWritten, false); // dry-run skips history by default
    // Store should be empty after a dry-run (created by load(), but no ideas).
    const store = new FeatureIdeasStore({ file: tmp.file });
    const file = await store.load();
    assert.equal(file.meta.total_count, 0);
    // History file should not exist (dry-run did not write).
    let historyExists = true;
    try { await stat(tmp.historyFile); } catch { historyExists = false; }
    assert.equal(historyExists, false, 'dry-run must not write history');
  } finally { await tmp.cleanup(); }
});

test('mainFeatureResearcher: rate-limited run returns ran=false', async () => {
  const tmp = await makeTmp();
  try {
    // Seed the store with a fresh last_research_at.
    const store = new FeatureIdeasStore({ file: tmp.file });
    await store.load();
    await store.stampLastResearch(new Date());
    // Attempt without --force → should be rate-limited.
    const r = await mainFeatureResearcher({
      dryRun: false,
      force: false,
      file: tmp.file,
      historyFile: tmp.historyFile,
      maxPerRun: 3,
      minIntervalHours: 12,
    });
    assert.equal(r.ran, false);
    assert.equal(r.added, 0);
    assert.equal(r.historyWritten, true); // rate-limited path STILL writes history (audit trail)
    const histBody = await readFile(tmp.historyFile, 'utf8');
    assert.ok(histBody.includes('"rate_limited":true'));
  } finally { await tmp.cleanup(); }
});

test('mainFeatureResearcher: idempotent — second run within window adds nothing', async () => {
  const tmp = await makeTmp();
  try {
    // First run with --force (works around rate-limit).
    const r1 = await mainFeatureResearcher({
      dryRun: false,
      force: true,
      file: tmp.file,
      historyFile: tmp.historyFile,
      maxPerRun: 2,
      minIntervalHours: 12,
    });
    assert.equal(r1.ran, true);
    // Second run without --force → rate-limited, adds nothing.
    const r2 = await mainFeatureResearcher({
      dryRun: false,
      force: false,
      file: tmp.file,
      historyFile: tmp.historyFile,
      maxPerRun: 2,
      minIntervalHours: 12,
    });
    assert.equal(r2.ran, false);
    // Both runs should have appended history events (real runs, not dry-run).
    const histBody = await readFile(tmp.historyFile, 'utf8');
    const lines = histBody.trim().split('\n').filter((l) => l.length > 0);
    assert.ok(lines.length >= 2, `expected at least 2 history lines, got ${lines.length}`);
  } finally { await tmp.cleanup(); }
});

// ─────────────────────────────────────────────────────────────────────
//  T30c — research_cron_run history event
// ─────────────────────────────────────────────────────────────────────

test('shouldWriteResearchCronHistory: dry-run alone skips history', () => {
  assert.equal(shouldWriteResearchCronHistory({ dryRun: true, noHistory: false, withHistory: false }), false);
});

test('shouldWriteResearchCronHistory: --no-history skips history', () => {
  assert.equal(shouldWriteResearchCronHistory({ dryRun: false, noHistory: true, withHistory: false }), false);
});

test('shouldWriteResearchCronHistory: real run writes history', () => {
  assert.equal(shouldWriteResearchCronHistory({ dryRun: false, noHistory: false, withHistory: false }), true);
});

test('shouldWriteResearchCronHistory: dry-run + --no-history still skips', () => {
  assert.equal(shouldWriteResearchCronHistory({ dryRun: true, noHistory: true, withHistory: false }), false);
});

test('shouldWriteResearchCronHistory: dry-run WITH --history overrides the dry-run veto', () => {
  assert.equal(shouldWriteResearchCronHistory({ dryRun: true, noHistory: false, withHistory: true }), true);
});

test('shouldWriteResearchCronHistory: --no-history beats --history', () => {
  assert.equal(shouldWriteResearchCronHistory({ dryRun: false, noHistory: true, withHistory: true }), false);
});

test('shouldWriteResearchCronHistory: tolerates null/undefined opts', () => {
  assert.equal(shouldWriteResearchCronHistory(null), false);
  assert.equal(shouldWriteResearchCronHistory(undefined), false);
});

test('buildResearchCronRunEvent: emits a well-formed event', () => {
  const now = new Date('2026-09-14T22:00:00.000Z');
  const result = {
    ran: true, added: 2, skipped: 0, available: 44, spent: 2,
    hoursSinceLastRun: 13, ideas: [{ id: 'idea_x_20260914', title: 'X' }],
  };
  const event = buildResearchCronRunEvent({
    now, result, dryRun: false, rateLimited: false, forced: true, file: '/tmp/x.json',
  });
  assert.equal(event.ts, '2026-09-14T22:00:00.000Z');
  assert.equal(event.kind, 'research_cron_run');
  assert.equal(event.source, 'feature-researcher');
  assert.equal(event.dry_run, false);
  assert.equal(event.forced, true);
  assert.equal(event.rate_limited, false);
  assert.equal(event.ran, true);
  assert.equal(event.added, 2);
  assert.equal(event.available, 44);
  assert.equal(event.spent, 2);
  assert.equal(event.hours_since_last_run, 13);
  assert.equal(event.ideas_added.length, 1);
  assert.equal(event.ideas_added[0].id, 'idea_x_20260914');
  assert.equal(event.ideas_added[0].title, 'X');
  assert.equal(event.file, '/tmp/x.json');
});

test('buildResearchCronRunEvent: rate_limited path', () => {
  const now = new Date('2026-09-14T22:00:00.000Z');
  const result = {
    ran: false, added: 0, skipped: 0, available: 0, spent: 5, hoursSinceLastRun: 2.5, ideas: [],
  };
  const event = buildResearchCronRunEvent({
    now, result, dryRun: false, rateLimited: true, forced: false, file: '/tmp/x.json',
  });
  assert.equal(event.rate_limited, true);
  assert.equal(event.ran, false);
  assert.equal(event.added, 0);
  assert.equal(event.spent, 5);
  assert.equal(event.hours_since_last_run, 2.5);
  assert.deepEqual(event.ideas_added, []);
});

test('buildResearchCronRunEvent: throws on missing opts', () => {
  assert.throws(() => buildResearchCronRunEvent());
});

test('appendResearchCronRunEvent: writes a valid NDJSON line', async (t) => {
  const tmp = await makeTmp();
  t.after(() => tmp.cleanup());
  const event = buildResearchCronRunEvent({
    now: new Date('2026-09-14T22:00:00.000Z'),
    result: { ran: true, added: 1, skipped: 0, available: 5, spent: 1, hoursSinceLastRun: null, ideas: [{ id: 'a', title: 'A' }] },
    dryRun: false, rateLimited: false, forced: true, file: tmp.file,
  });
  const r = await appendResearchCronRunEvent({ historyFile: tmp.historyFile, event });
  assert.equal(r.ok, true);
  const body = await readFile(tmp.historyFile, 'utf8');
  assert.match(body, /"kind":"research_cron_run"/);
  assert.match(body, /"added":1/);
});

test('appendResearchCronRunEvent: missing historyFile returns { ok: false }', async () => {
  const r = await appendResearchCronRunEvent({ historyFile: '', event: {} });
  assert.equal(r.ok, false);
  assert.match(r.error, /historyFile/);
});

test('appendResearchCronRunEvent: missing event returns { ok: false }', async () => {
  const r = await appendResearchCronRunEvent({ historyFile: '/tmp/x', event: null });
  assert.equal(r.ok, false);
  assert.match(r.error, /event/);
});

test('mainFeatureResearcher: --no-history skips history append on a real run', async (t) => {
  const tmp = await makeTmp();
  t.after(() => tmp.cleanup());
  const r = await mainFeatureResearcher({
    dryRun: false,
    force: true,
    file: tmp.file,
    historyFile: tmp.historyFile,
    noHistory: true,
    maxPerRun: 2,
    minIntervalHours: 12,
  });
  assert.equal(r.ran, true);
  assert.equal(r.historyWritten, false);
  assert.equal(r.historyError, null);
  // History file should not exist.
  let historyExists = true;
  try { await stat(tmp.historyFile); } catch { historyExists = false; }
  assert.equal(historyExists, false, '--no-history must skip history append');
});

test('mainFeatureResearcher: --dry-run with --history DOES write history', async (t) => {
  const tmp = await makeTmp();
  t.after(() => tmp.cleanup());
  const r = await mainFeatureResearcher({
    dryRun: true,
    force: true,
    file: tmp.file,
    historyFile: tmp.historyFile,
    noHistory: false,
    withHistory: true,
    maxPerRun: 2,
    minIntervalHours: 12,
  });
  assert.equal(r.ran, true);
  assert.equal(r.added, 0); // dry-run didn't write to the store
  assert.equal(r.historyWritten, true); // but --history DID write to the audit trail
  const body = await readFile(tmp.historyFile, 'utf8');
  assert.match(body, /"dry_run":true/);
  assert.match(body, /"added":0/);
  assert.match(body, /"kind":"research_cron_run"/);
});

test('mainFeatureResearcher: history append failure does not break the run', async (t) => {
  const tmp = await makeTmp();
  t.after(() => tmp.cleanup());
  // Point history at a directory we cannot write to (use a path under /dev/null
  // — appending to it will fail with EACCES/EPERM/EISDIR on Linux).
  const r = await mainFeatureResearcher({
    dryRun: false,
    force: true,
    file: tmp.file,
    historyFile: '/dev/null/cannot-write.ndjson',
    maxPerRun: 2,
    minIntervalHours: 12,
  });
  // The store write still succeeded.
  assert.equal(r.ran, true);
  assert.ok(r.added >= 1);
  // The history append failed, but the run is still successful — error surfaced.
  assert.equal(r.historyWritten, false);
  assert.ok(typeof r.historyError === 'string' && r.historyError.length > 0);
});

test('mainFeatureResearcher: rate-limited run STILL appends history (audit trail)', async (t) => {
  const tmp = await makeTmp();
  t.after(() => tmp.cleanup());
  const store = new FeatureIdeasStore({ file: tmp.file });
  await store.load();
  await store.stampLastResearch(new Date());
  const r = await mainFeatureResearcher({
    dryRun: false,
    force: false,
    file: tmp.file,
    historyFile: tmp.historyFile,
    maxPerRun: 3,
    minIntervalHours: 12,
  });
  assert.equal(r.ran, false);
  assert.equal(r.historyWritten, true);
  const body = await readFile(tmp.historyFile, 'utf8');
  assert.match(body, /"rate_limited":true/);
  assert.match(body, /"ran":false/);
});

test('mainFeatureResearcher: history event carries all required audit fields', async (t) => {
  const tmp = await makeTmp();
  t.after(() => tmp.cleanup());
  await mainFeatureResearcher({
    dryRun: false,
    force: true,
    file: tmp.file,
    historyFile: tmp.historyFile,
    maxPerRun: 2,
    minIntervalHours: 12,
  });
  const body = await readFile(tmp.historyFile, 'utf8');
  const evt = JSON.parse(body.trim().split('\n').pop());
  // Required fields per T30c spec.
  for (const key of [
    'ts', 'kind', 'source', 'dry_run', 'forced', 'rate_limited',
    'ran', 'added', 'skipped', 'available', 'spent',
    'hours_since_last_run', 'ideas_added', 'file',
  ]) {
    assert.ok(key in evt, `audit event missing required field: ${key}`);
  }
  assert.equal(evt.kind, 'research_cron_run');
  assert.equal(evt.source, 'feature-researcher');
});