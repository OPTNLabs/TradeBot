#!/usr/bin/env node
// dashboard/tests/proposals-view.test.mjs
//
// Unit tests for the pure helpers exported from
// `src/views/Proposals.jsx`. The view itself is a React component;
// we don't pull in jsdom for these tests — we just exercise the
// stateless helpers that drive the rendering.

import { describe, it } from 'node:test';
import { strictEqual, ok, match, deepStrictEqual } from 'node:assert';

import {
  statusClass,
  impactClass,
  effortLabel,
  relativeTime,
  countsFromMeta,
  emptyOperatorDraft,
  validateOperatorDraft,
  csvToCategoryTags,
  CATEGORY_OPTIONS,
  EFFORT_OPTIONS,
  IMPACT_OPTIONS,
} from '../src/views/proposals-helpers.mjs';

// ─── statusClass ────────────────────────────────────────────────────

describe('statusClass', () => {
  it('approved → pnl-pos colors', () => {
    ok(statusClass('approved').includes('pnl-pos'));
  });
  it('shipped → bch-500 colors', () => {
    ok(statusClass('shipped').includes('bch-500'));
  });
  it('rejected → pnl-neg colors', () => {
    ok(statusClass('rejected').includes('pnl-neg'));
  });
  it('pending → ash text on ink', () => {
    ok(statusClass('pending').includes('ink-800'));
  });
  it('unknown → falls through to ink', () => {
    ok(statusClass('something-else').includes('ink'));
  });
  it('non-string → falls through', () => {
    ok(statusClass(null).includes('ink'));
    ok(statusClass(undefined).includes('ink'));
  });
});

// ─── impactClass ────────────────────────────────────────────────────

describe('impactClass', () => {
  it('high → bch-500 accent', () => {
    ok(impactClass('high').includes('bch-500'));
  });
  it('medium → muted ash', () => {
    ok(impactClass('medium').includes('ink-800'));
  });
  it('low → very muted', () => {
    ok(impactClass('low').includes('ink-800'));
  });
  it('unknown → falls through to ink', () => {
    ok(impactClass('xyz').includes('ink'));
  });
});

// ─── effortLabel ────────────────────────────────────────────────────

describe('effortLabel', () => {
  it('S → small', () => strictEqual(effortLabel('S'), 'small'));
  it('M → medium', () => strictEqual(effortLabel('M'), 'medium'));
  it('L → large', () => strictEqual(effortLabel('L'), 'large'));
  it('unknown → passes through', () => strictEqual(effortLabel('XL'), 'XL'));
  it('empty → em dash', () => strictEqual(effortLabel(''), '—'));
  it('null → em dash', () => strictEqual(effortLabel(null), '—'));
});

// ─── relativeTime ───────────────────────────────────────────────────

describe('relativeTime', () => {
  const nowMs = new Date('2026-09-14T12:00:00Z').getTime();

  it('non-string → never', () => {
    strictEqual(relativeTime(null, nowMs), 'never');
    strictEqual(relativeTime(undefined, nowMs), 'never');
    strictEqual(relativeTime('', nowMs), 'never');
  });

  it('invalid ISO → never', () => {
    strictEqual(relativeTime('not-a-date', nowMs), 'never');
  });

  it('seconds → "Ns ago"', () => {
    const iso = new Date(nowMs - 30 * 1000).toISOString();
    strictEqual(relativeTime(iso, nowMs), '30s ago');
  });

  it('minutes → "Nm ago"', () => {
    const iso = new Date(nowMs - 5 * 60 * 1000).toISOString();
    strictEqual(relativeTime(iso, nowMs), '5m ago');
  });

  it('hours → "Nh ago"', () => {
    const iso = new Date(nowMs - 3 * 60 * 60 * 1000).toISOString();
    strictEqual(relativeTime(iso, nowMs), '3h ago');
  });

  it('days → "Nd ago"', () => {
    const iso = new Date(nowMs - 2 * 24 * 60 * 60 * 1000).toISOString();
    strictEqual(relativeTime(iso, nowMs), '2d ago');
  });

  it('>30 days → ISO date string', () => {
    const iso = '2026-01-01T00:00:00Z';
    const out = relativeTime(iso, nowMs);
    match(out, /2026-01-01/);
  });

  it('future → "in the future"', () => {
    const iso = new Date(nowMs + 60 * 1000).toISOString();
    strictEqual(relativeTime(iso, nowMs), 'in the future');
  });
});

// ─── countsFromMeta ─────────────────────────────────────────────

describe('countsFromMeta', () => {
  it('returns zeros for null meta', () => {
    const c = countsFromMeta(null);
    strictEqual(c.all, 0);
    strictEqual(c.pending, 0);
    strictEqual(c.approved, 0);
    strictEqual(c.rejected, 0);
    strictEqual(c.shipped, 0);
  });

  it('returns zeros for undefined meta', () => {
    const c = countsFromMeta(undefined);
    strictEqual(c.all, 0);
    strictEqual(c.pending, 0);
    strictEqual(c.approved, 0);
    strictEqual(c.rejected, 0);
    strictEqual(c.shipped, 0);
  });

  it('returns zeros for a non-object meta', () => {
    strictEqual(countsFromMeta('hello').all, 0);
    strictEqual(countsFromMeta(42).all, 0);
    strictEqual(countsFromMeta([1,2,3]).all, 0);
  });

  it('returns zeros for missing fields (not the same as zero counts!)', () => {
    // CRITICAL: an empty meta is NOT the same as "store is empty".
    // The bug this guards against: deriving counts from a filtered
    // list returned zero for non-selected statuses, which made the
    // filter chips look broken after an approval.
    const c = countsFromMeta({});
    strictEqual(c.all, 0);
    strictEqual(c.pending, 0);
    strictEqual(c.approved, 0);
    strictEqual(c.rejected, 0);
    strictEqual(c.shipped, 0);
  });

  it('reads per-status counts from a well-formed meta', () => {
    const c = countsFromMeta({
      total_count: 22,
      pending_count: 19,
      approved_count: 3,
      rejected_count: 0,
      shipped_count: 0,
      last_research_at: '2026-09-14T20:46:10.524Z',
    });
    strictEqual(c.all, 22);
    strictEqual(c.pending, 19);
    strictEqual(c.approved, 3);
    strictEqual(c.rejected, 0);
    strictEqual(c.shipped, 0);
  });

  it('regression: returns global counts even when only "pending" was selected', () => {
    // THE BUG: before this helper existed, `counts` was derived
    // from `data.ideas` — the FILTERED list. So with status=pending
    // active, ideas=[19 pending], and `approved_count` would be 0
    // even if 3 ideas were actually approved globally. Selecting
    // the Approved tab would then also show 0. This helper exists
    // exactly to avoid that.
    const c = countsFromMeta({
      total_count: 22,
      pending_count: 19,
      approved_count: 3,
      rejected_count: 0,
      shipped_count: 0,
    });
    // Approving a pending idea should leave global approved# at 3
    // (not bump it, because the meta is the SAME between the
    // pre-approve and post-approve requests — the SERVER keeps
    // accurate counts in meta).
    strictEqual(c.approved, 3);
    strictEqual(c.pending, 19);
  });

  it('handles non-numeric / negative / fractional values gracefully', () => {
    const c = countsFromMeta({
      total_count: 'oops',
      pending_count: -3,
      approved_count: 1.5,
      rejected_count: NaN,
      shipped_count: Infinity,
    });
    strictEqual(c.all, 0);
    strictEqual(c.pending, 0);
    strictEqual(c.approved, 1);
    strictEqual(c.rejected, 0);
    strictEqual(c.shipped, 0);
  });
});

// ─── Operator-create form helpers ───────────────────────────────

describe('emptyOperatorDraft', () => {
  it('returns sensible defaults', () => {
    const d = emptyOperatorDraft();
    strictEqual(d.title, '');
    strictEqual(d.rationale, '');
    strictEqual(d.evidence, '');
    strictEqual(d.category_tags_csv, '');
    // Sensible defaults — the user can change any of these.
    strictEqual(d.category, 'edge-case-protection');
    strictEqual(d.effort, 'M');
    strictEqual(d.impact, 'medium');
  });

  it('returns a NEW object every call (so mutations don\'t leak between forms)', () => {
    const a = emptyOperatorDraft();
    const b = emptyOperatorDraft();
    a.title = 'leakage';
    strictEqual(b.title, '');
  });
});

describe('validateOperatorDraft', () => {
  it('accepts a well-formed draft', () => {
    const v = validateOperatorDraft({
      title: 'Manual trade UI',
      category: 'dashboard',
      rationale: 'so the operator can intervene',
      effort: 'L',
      impact: 'medium',
    });
    deepStrictEqual(v, { ok: true });
  });

  it('rejects an empty title', () => {
    const v = validateOperatorDraft({
      title: '   ', category: 'dashboard', rationale: 'r', effort: 'S', impact: 'low',
    });
    strictEqual(v.ok, false);
    match(v.error, /title is required/);
  });

  it('rejects a > 200 char title', () => {
    const v = validateOperatorDraft({
      title: 'x'.repeat(201), category: 'dashboard', rationale: 'r', effort: 'S', impact: 'low',
    });
    strictEqual(v.ok, false);
    match(v.error, /title must be ≤ 200 chars/);
  });

  it('rejects an unknown category', () => {
    const v = validateOperatorDraft({
      title: 'x', category: 'wrong-cat', rationale: 'r', effort: 'S', impact: 'low',
    });
    strictEqual(v.ok, false);
    match(v.error, /category must be one of/);
  });

  it('rejects an empty rationale', () => {
    const v = validateOperatorDraft({
      title: 'x', category: 'dashboard', rationale: '', effort: 'S', impact: 'low',
    });
    strictEqual(v.ok, false);
    match(v.error, /rationale is required/);
  });

  it('rejects an unknown effort', () => {
    const v = validateOperatorDraft({
      title: 'x', category: 'dashboard', rationale: 'r', effort: 'XL', impact: 'low',
    });
    strictEqual(v.ok, false);
    match(v.error, /effort must be one of/);
  });

  it('rejects an unknown impact', () => {
    const v = validateOperatorDraft({
      title: 'x', category: 'dashboard', rationale: 'r', effort: 'S', impact: 'huge',
    });
    strictEqual(v.ok, false);
    match(v.error, /impact must be one of/);
  });

  it('rejects a null / non-object draft', () => {
    strictEqual(validateOperatorDraft(null).ok, false);
    strictEqual(validateOperatorDraft(undefined).ok, false);
    strictEqual(validateOperatorDraft('string').ok, false);
    strictEqual(validateOperatorDraft(42).ok, false);
  });

  it('coerces non-string fields via String() before checking', () => {
    // Defensive: form state could theoretically have a non-string from
    // a misbehaving browser. Accept any value that stringifies to a
    // non-empty trimmed value.
    const v = validateOperatorDraft({
      title: 42, category: 'dashboard', rationale: 'r', effort: 'S', impact: 'low',
    });
    deepStrictEqual(v, { ok: true });
  });
});

describe('csvToCategoryTags', () => {
  it('splits + trims + drops empties', () => {
    const out = csvToCategoryTags({ category_tags_csv: 'a, b ,c, , d' });
    deepStrictEqual(out, ['a', 'b', 'c', 'd']);
  });
  it('returns [] for empty / missing', () => {
    deepStrictEqual(csvToCategoryTags({}), []);
    deepStrictEqual(csvToCategoryTags({ category_tags_csv: '' }), []);
    deepStrictEqual(csvToCategoryTags({ category_tags_csv: '   ' }), []);
  });
  it('handles non-string csv gracefully', () => {
    deepStrictEqual(csvToCategoryTags({ category_tags_csv: null }), []);
    deepStrictEqual(csvToCategoryTags({ category_tags_csv: 42 }), []);
  });
});

describe('CATEGORY_OPTIONS / EFFORT_OPTIONS / IMPACT_OPTIONS', () => {
  it('CATEGORY_OPTIONS contains all 5 fixed categories', () => {
    const values = CATEGORY_OPTIONS.map((c) => c.value);
    deepStrictEqual(values.sort(), [
      'dashboard', 'decision-logic', 'edge-case-protection', 'observability', 'performance',
    ]);
  });
  it('EFFORT_OPTIONS is exactly S / M / L', () => {
    deepStrictEqual(EFFORT_OPTIONS.map((e) => e.value), ['S', 'M', 'L']);
  });
  it('IMPACT_OPTIONS is exactly low / medium / high', () => {
    deepStrictEqual(IMPACT_OPTIONS.map((i) => i.value), ['low', 'medium', 'high']);
  });
});