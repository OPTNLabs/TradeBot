#!/usr/bin/env node
/**
 * Unit tests for src/bugs/schema.mjs.
 *
 * Pure-function tests. No I/O, no logger. Run via `npm test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUGS_VERSION,
  BUGS_CATEGORIES,
  BUGS_SEVERITIES,
  BUGS_STATUSES,
  DEFAULT_BUG_SEVERITY,
  slugify,
  operatorBugIdForTitle,
  validateBug,
  validateBugsFile,
  buildMetaForBugs,
  nextDefaultPriority,
} from '../src/bugs/schema.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────────────

test('BUGS_VERSION is 1', () => {
  assert.equal(BUGS_VERSION, 1);
});

test('BUGS_CATEGORIES covers the seven dashboard tabs', () => {
  assert.deepEqual([...BUGS_CATEGORIES], [
    'ui', 'data', 'logic', 'performance', 'config', 'wallet', 'other',
  ]);
});

test('BUGS_SEVERITIES is low|medium|high|critical', () => {
  assert.deepEqual([...BUGS_SEVERITIES], ['low', 'medium', 'high', 'critical']);
});

test('BUGS_STATUSES is open|in_progress|shipped|wontfix', () => {
  assert.deepEqual([...BUGS_STATUSES], ['open', 'in_progress', 'shipped', 'wontfix']);
});

test('DEFAULT_BUG_SEVERITY is medium (the middle of the queue)', () => {
  assert.equal(DEFAULT_BUG_SEVERITY, 'medium');
});

// ─────────────────────────────────────────────────────────────────────
//  slugify
// ─────────────────────────────────────────────────────────────────────

test('slugify: lowercase + non-alphanumeric → -', () => {
  assert.equal(slugify('Cumulative P&L shows wrong total'), 'cumulative-p-l-shows-wrong-total');
});

test('slugify: collapses runs of dashes + trims leading/trailing', () => {
  assert.equal(slugify('  Spaces —  + weird chars?! '), 'spaces-weird-chars');
});

test('slugify: diacritics are decomposed (Café → cafe)', () => {
  assert.equal(slugify('Café crash on login'), 'cafe-crash-on-login');
});

test('slugify: all-punctuation / empty / non-string → "bug" fallback', () => {
  // Pure-helper contract: anything that strips to nothing (operator
  // typed only punctuation, empty string, or no string at all)
  // falls back to the placeholder `bug`. `operatorBugIdForTitle`
  // composes that into a stable id like `bug-bug-20260915` so the
  // supervisor-bridge can still produce a key even when the
  // operator submits a one-character title.
  assert.equal(slugify('!!!'), 'bug');
  assert.equal(slugify(''), 'bug');
  assert.equal(slugify(null), 'bug');
  assert.equal(slugify(undefined), 'bug');
});

// ─────────────────────────────────────────────────────────────────────
//  operatorBugIdForTitle
// ─────────────────────────────────────────────────────────────────────

test('operatorBugIdForTitle: timestamp + slug in the id', () => {
  const id = operatorBugIdForTitle('Charts blank after refresh', new Date('2026-09-15T12:00:00Z'));
  assert.equal(id, 'bug-charts-blank-after-refresh-20260915');
});

test('operatorBugIdForTitle: default now when not supplied', () => {
  const id = operatorBugIdForTitle('Test');
  assert.match(id, /^bug-test-\d{8}$/);
});

// ─────────────────────────────────────────────────────────────────────
//  validateBug
// ─────────────────────────────────────────────────────────────────────

const validBug = (overrides = {}) => ({
  id: 'bug-cumulative-p-l-wrong-20260915',
  title: 'Cumulative P&L shows wrong total',
  description: 'The total at the right of the cumulative P&L chart reads +0.00193905 BCH but should be -0.00036502 BCH after the BADGER fix.',
  category: 'ui',
  severity: 'high',
  status: 'open',
  priority: 0,
  created_at: '2026-09-15T12:00:00.000Z',
  updated_at: '2026-09-15T12:00:00.000Z',
  shipped_in: null,
  notes: [],
  ...overrides,
});

test('validateBug: happy path', () => {
  const b = validateBug(validBug());
  assert.equal(b.id, validBug().id);
  assert.equal(b.title, 'Cumulative P&L shows wrong total'); // trims whitespace
  assert.equal(Object.isFrozen(b), true);
});

test('validateBug: rejects bad category', () => {
  assert.throws(() => validateBug(validBug({ category: 'unknown' })), /category must be one of/);
});

test('validateBug: rejects bad severity', () => {
  assert.throws(() => validateBug(validBug({ severity: 'extreme' })), /severity must be one of/);
});

test('validateBug: rejects bad status', () => {
  assert.throws(() => validateBug(validBug({ status: 'pending' })), /status must be one of/);
});

test('validateBug: rejects non-integer priority', () => {
  assert.throws(() => validateBug(validBug({ priority: 1.5 })), /priority must be an integer/);
});

test('validateBug: rejects missing created_at', () => {
  assert.throws(() => {
    const b = validBug();
    delete b.created_at;
    validateBug(b);
  }, /created_at must be ISO 8601/);
});

test('validateBug: rejects empty title', () => {
  assert.throws(() => validateBug(validBug({ title: '   ' })), /title required/);
});

test('validateBug: rejects empty description', () => {
  assert.throws(() => validateBug(validBug({ description: '' })), /description required/);
  assert.throws(() => validateBug(validBug({ description: '   ' })), /description required/);
});

test('validateBug: non-string shipped_in silently coerces to null', () => {
  // The validator's contract: shipped_in must be EITHER a non-empty
  // string commit SHA, OR null/missing. Non-string truthy values
  // (0, false) cleanly collapse to null rather than throw, so a
  // partially-migrated record with a stale numeric/boolean
  // shipped_in still validates. The stored value then becomes
  // null on the next write.
  const b = validateBug(validBug({ shipped_in: 0 }));
  assert.equal(b.shipped_in, null);
  const c = validateBug(validBug({ shipped_in: false }));
  assert.equal(c.shipped_in, null);
});

test('validateBug: accepts notes array', () => {
  const b = validateBug(validBug({
    notes: [{ ts: '2026-09-15T12:00:00.000Z', author: 'operator', body: 'reproduced' }],
  }));
  assert.equal(b.notes.length, 1);
  assert.equal(b.notes[0].author, 'operator');
});

// ─────────────────────────────────────────────────────────────────────
//  validateBugsFile
// ─────────────────────────────────────────────────────────────────────

test('validateBugsFile: empty bugs list', () => {
  const f = validateBugsFile({ version: 1, bugs: [], meta: {} });
  assert.equal(f.bugs.length, 0);
  assert.equal(f.meta.total_count, 0);
});

test('validateBugsFile: rejects wrong version', () => {
  assert.throws(() => validateBugsFile({ version: 2, bugs: [], meta: {} }), /unsupported version/);
});

test('validateBugsFile: rejects non-array bugs', () => {
  assert.throws(() => validateBugsFile({ version: 1, bugs: 'not-an-array', meta: {} }), /bugs must be an array/);
});

test('validateBugsFile: validates each bug', () => {
  assert.throws(
    () => validateBugsFile({ version: 1, bugs: [validBug({ category: 'wrong' })], meta: {} }),
    /category must be one of/,
  );
});

// ─────────────────────────────────────────────────────────────────────
//  buildMetaForBugs
// ─────────────────────────────────────────────────────────────────────

test('buildMetaForBugs: counts per status + next/highest priority', () => {
  const bugs = [
    validBug({ priority: 0, status: 'open' }),
    validBug({ priority: 1, status: 'open' }),
    validBug({ priority: 2, status: 'in_progress' }),
    validBug({ priority: 3, status: 'shipped' }),
  ];
  const meta = buildMetaForBugs(bugs);
  assert.equal(meta.total_count, 4);
  assert.equal(meta.open_count, 2);
  assert.equal(meta.in_progress_count, 1);
  assert.equal(meta.shipped_count, 1);
  assert.equal(meta.wontfix_count, 0);
  assert.equal(meta.highest_priority, 0); // lowest int = highest priority
  assert.equal(meta.next_priority, -1);    // one less than lowest open
});

test('buildMetaForBugs: empty list returns zeros + null highest', () => {
  const meta = buildMetaForBugs([]);
  assert.equal(meta.total_count, 0);
  assert.equal(meta.open_count, 0);
  assert.equal(meta.highest_priority, null);
  assert.equal(meta.next_priority, 0);
});

// ─────────────────────────────────────────────────────────────────────
//  nextDefaultPriority
// ─────────────────────────────────────────────────────────────────────

test('nextDefaultPriority: one less than lowest open', () => {
  const bugs = [
    validBug({ priority: 5, status: 'open' }),
    validBug({ priority: 0, status: 'open' }),
  ];
  assert.equal(nextDefaultPriority(bugs), -1);
});

test('nextDefaultPriority: 0 when no open bugs', () => {
  const bugs = [
    validBug({ priority: 5, status: 'shipped' }),
    validBug({ priority: 3, status: 'in_progress' }),
  ];
  assert.equal(nextDefaultPriority(bugs), 0);
});

test('nextDefaultPriority: ignores wontfix / shipped', () => {
  // Order-of-operations: a flood of shipped/wontfix at low
  // priorities shouldn't drag the new-bug default negative.
  const bugs = [
    validBug({ priority: -100, status: 'shipped' }),
    validBug({ priority: -50, status: 'wontfix' }),
  ];
  assert.equal(nextDefaultPriority(bugs), 0);
});
