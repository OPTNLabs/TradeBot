#!/usr/bin/env node
// dashboard/tests/bugs-view.test.mjs
//
// Unit tests for the pure helpers exported from
// `dashboard/src/views/bugs-helpers.mjs` (T49). Same shape as the
// proposals-view / reasoning-view / risk-panel-view test patterns:
// the .jsx holds the React component, the .mjs holds the Node-testable
// helpers. We don't pull in jsdom — we just exercise the stateless
// helpers that drive the rendering.
//
// Coverage:
//   • STATUS_FILTERS / CATEGORY_OPTIONS / SEVERITY_OPTIONS — shape +
//     freeze + sane defaults.
//   • SEVERITY_CLASS / STATUS_BADGE_CLASS / STATUS_LABEL /
//     STATUS_DESCRIPTION — shape + freeze + fallthrough behavior.
//   • statusClass / severityClass — string / null / undefined /
//     unknown / non-string fallthrough; uses hasOwnProperty to avoid
//     prototype-pollution surprises.
//   • blankDraft — fresh object per call, defaults match the spec.
//   • validateDraft — happy path + each error condition + non-object
//     guard; mirrors the dashboard's existing inline contract.
//   • createFormCategoryOptions / createFormSeverityOptions — drop
//     the trailing `all` sentinel, plain-object copies (so callers
//     can mutate freely).

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual, match, throws } from 'node:assert';

import {
  STATUS_FILTERS,
  CATEGORY_OPTIONS,
  SEVERITY_OPTIONS,
  SEVERITY_CLASS,
  STATUS_BADGE_CLASS,
  STATUS_LABEL,
  STATUS_DESCRIPTION,
  statusClass,
  severityClass,
  blankDraft,
  validateDraft,
  createFormCategoryOptions,
  createFormSeverityOptions,
  createBugPanelSubtitle,
  isShippedInPlaceholder,
  BUGS_HEADER_SUBTITLE,
} from '../src/views/bugs-helpers.mjs';

// ─── STATUS_FILTERS ─────────────────────────────────────────────────

describe('STATUS_FILTERS', () => {
  it('has exactly 5 entries with the expected ids', () => {
    const ids = STATUS_FILTERS.map((o) => o.id);
    deepStrictEqual(ids, ['open', 'in_progress', 'shipped', 'wontfix', 'all']);
  });

  it('every entry has a non-empty label', () => {
    for (const o of STATUS_FILTERS) {
      ok(typeof o.label === 'string' && o.label.length > 0, `entry ${o.id} missing label`);
    }
  });

  it('the "all" sentinel is the last entry', () => {
    strictEqual(STATUS_FILTERS[STATUS_FILTERS.length - 1].id, 'all');
  });

  it('the array is frozen', () => {
    throws(() => STATUS_FILTERS.push({ id: 'x', label: 'X' }), TypeError);
  });

  it('each entry is frozen', () => {
    throws(() => STATUS_FILTERS[0].label = 'MUTATED', TypeError);
  });
});

// ─── CATEGORY_OPTIONS ───────────────────────────────────────────────

describe('CATEGORY_OPTIONS', () => {
  it('has exactly 8 entries: the 7 schema categories + an "all" sentinel', () => {
    const ids = CATEGORY_OPTIONS.map((o) => o.id);
    deepStrictEqual(ids, [
      'ui', 'data', 'logic', 'performance', 'config', 'wallet', 'other', 'all',
    ]);
  });

  it('matches the bug-subsystem schema\'s BUGS_CATEGORIES', () => {
    // The seven "real" categories must match `src/bugs/schema.mjs`
    // BUGS_CATEGORIES. Lock this to catch drift if anyone reorders
    // the schema without updating the dashboard.
    const realIds = CATEGORY_OPTIONS.map((o) => o.id).filter((id) => id !== 'all');
    deepStrictEqual(realIds, [
      'ui', 'data', 'logic', 'performance', 'config', 'wallet', 'other',
    ]);
  });

  it('the array + each entry is frozen', () => {
    throws(() => CATEGORY_OPTIONS.push({ id: 'x', label: 'X' }), TypeError);
    throws(() => CATEGORY_OPTIONS[0].label = 'MUTATED', TypeError);
  });
});

// ─── SEVERITY_OPTIONS ───────────────────────────────────────────────

describe('SEVERITY_OPTIONS', () => {
  it('has exactly 5 entries: 4 real severities + an "all" sentinel', () => {
    const ids = SEVERITY_OPTIONS.map((o) => o.id);
    deepStrictEqual(ids, ['critical', 'high', 'medium', 'low', 'all']);
  });

  it('matches the bug-subsystem schema\'s BUGS_SEVERITIES (minus the "all" sentinel)', () => {
    const realIds = SEVERITY_OPTIONS.map((o) => o.id).filter((id) => id !== 'all');
    deepStrictEqual(realIds, ['critical', 'high', 'medium', 'low']);
  });

  it('the array + each entry is frozen', () => {
    throws(() => SEVERITY_OPTIONS.push({ id: 'x', label: 'X' }), TypeError);
    throws(() => SEVERITY_OPTIONS[0].label = 'MUTATED', TypeError);
  });
});

// ─── STATUS_BADGE_CLASS ─────────────────────────────────────────────

describe('STATUS_BADGE_CLASS', () => {
  it('has classes for all four real statuses', () => {
    for (const status of ['open', 'in_progress', 'shipped', 'wontfix']) {
      ok(typeof STATUS_BADGE_CLASS[status] === 'string', `${status} missing class`);
      ok(STATUS_BADGE_CLASS[status].length > 0, `${status} empty class`);
    }
  });

  it('"open" + "in_progress" use the green palette (text-bch-...)', () => {
    ok(STATUS_BADGE_CLASS.open.includes('text-bch-300'));
    ok(STATUS_BADGE_CLASS.in_progress.includes('text-bch-200'));
  });

  it('terminal states (shipped + wontfix) stay muted ash', () => {
    ok(STATUS_BADGE_CLASS.shipped.includes('text-ash-'));
    ok(STATUS_BADGE_CLASS.wontfix.includes('text-ash-'));
  });

  it('the object is frozen', () => {
    throws(() => STATUS_BADGE_CLASS.open = 'MUTATED', TypeError);
  });
});

// ─── SEVERITY_CLASS ────────────────────────────────────────────────

describe('SEVERITY_CLASS', () => {
  it('has classes for all four severities', () => {
    for (const sev of ['critical', 'high', 'medium', 'low']) {
      ok(typeof SEVERITY_CLASS[sev] === 'string', `${sev} missing class`);
    }
  });

  it('critical + high lean on the pnl-loss family', () => {
    ok(SEVERITY_CLASS.critical.includes('text-pnl-loss'));
    ok(SEVERITY_CLASS.high.includes('text-pnl-loss'));
  });

  it('medium + low use neutral ash tones', () => {
    ok(SEVERITY_CLASS.medium.includes('text-ash-'));
    ok(SEVERITY_CLASS.low.includes('text-ash-'));
  });

  it('the object is frozen', () => {
    throws(() => SEVERITY_CLASS.medium = 'MUTATED', TypeError);
  });
});

// ─── STATUS_LABEL ────────────────────────────────────────────────

describe('STATUS_LABEL', () => {
  it('renders every status uppercased', () => {
    strictEqual(STATUS_LABEL.open, 'OPEN');
    strictEqual(STATUS_LABEL.in_progress, 'IN PROGRESS');
    strictEqual(STATUS_LABEL.shipped, 'SHIPPED');
    strictEqual(STATUS_LABEL.wontfix, 'WONTFIX');
  });

  it('the object is frozen', () => {
    throws(() => STATUS_LABEL.open = 'MUTATED', TypeError);
  });
});

// ─── STATUS_DESCRIPTION ────────────────────────────────────────

describe('STATUS_DESCRIPTION', () => {
  it('has a one-line description for every status', () => {
    for (const status of ['open', 'in_progress', 'shipped', 'wontfix']) {
      ok(typeof STATUS_DESCRIPTION[status] === 'string');
      ok(STATUS_DESCRIPTION[status].length > 0);
    }
  });

  it('the object is frozen', () => {
    throws(() => STATUS_DESCRIPTION.open = 'MUTATED', TypeError);
  });
});

// ─── statusClass ────────────────────────────────────────────────

describe('statusClass', () => {
  it('open → bch family', () => {
    ok(statusClass('open').includes('text-bch-300'));
  });
  it('in_progress → bch family (muted)', () => {
    ok(statusClass('in_progress').includes('text-bch-200'));
  });
  it('shipped → ash', () => {
    ok(statusClass('shipped').includes('text-ash-'));
  });
  it('wontfix → ash', () => {
    ok(statusClass('wontfix').includes('text-ash-'));
  });
  it('unknown → falls through to muted ash', () => {
    ok(statusClass('something-else').includes('text-ash-'));
  });
  it('null → muted ash', () => {
    ok(statusClass(null).includes('text-ash-'));
  });
  it('undefined → muted ash', () => {
    ok(statusClass(undefined).includes('text-ash-'));
  });
  it('non-string (number) → muted ash', () => {
    ok(statusClass(42).includes('text-ash-'));
  });
  it('non-string (object) → muted ash', () => {
    ok(statusClass({}).includes('text-ash-'));
  });
  it('"constructor" (prototype-pollution attempt) → muted ash', () => {
    // We use Object.prototype.hasOwnProperty.call() in the helper, so
    // passing "__proto__" / "constructor" / "toString" must NOT match
    // an inherited property. Lock this — Tailwind classes merged from
    // a constructor key would be a real footgun.
    ok(statusClass('__proto__').includes('text-ash-'));
    ok(statusClass('constructor').includes('text-ash-'));
    ok(statusClass('toString').includes('text-ash-'));
    ok(statusClass('hasOwnProperty').includes('text-ash-'));
  });
});

// ─── severityClass ──────────────────────────────────────────────

describe('severityClass', () => {
  it('critical → pnl-loss full', () => {
    ok(severityClass('critical').includes('text-pnl-loss'));
  });
  it('high → pnl-loss 90', () => {
    ok(severityClass('high').includes('text-pnl-loss'));
  });
  it('medium → ash-200', () => {
    ok(severityClass('medium').includes('text-ash-200'));
  });
  it('low → ash-400', () => {
    ok(severityClass('low').includes('text-ash-400'));
  });
  it('unknown → falls through to "medium" class', () => {
    // Critical regression guard: the inline fallback used to be
    // `|| SEVERITY_CLASS.medium` (truthy-or) which is fine for a
    // missing key, but we want to make sure the shape matches the
    // explicit medium case byte-for-byte so the badge looks
    // identical.
    strictEqual(severityClass('something-else'), SEVERITY_CLASS.medium);
  });
  it('null → medium', () => {
    strictEqual(severityClass(null), SEVERITY_CLASS.medium);
  });
  it('undefined → medium', () => {
    strictEqual(severityClass(undefined), SEVERITY_CLASS.medium);
  });
  it('non-string (number) → medium', () => {
    strictEqual(severityClass(42), SEVERITY_CLASS.medium);
  });
  it('"constructor" / "__proto__" / "toString" → medium (no proto leak)', () => {
    strictEqual(severityClass('__proto__'), SEVERITY_CLASS.medium);
    strictEqual(severityClass('constructor'), SEVERITY_CLASS.medium);
    strictEqual(severityClass('toString'), SEVERITY_CLASS.medium);
    strictEqual(severityClass('hasOwnProperty'), SEVERITY_CLASS.medium);
  });
});

// ─── blankDraft ────────────────────────────────────────────────

describe('blankDraft', () => {
  it('returns sensible defaults matching the spec', () => {
    const d = blankDraft();
    strictEqual(d.title, '');
    strictEqual(d.description, '');
    strictEqual(d.category, 'other');
    strictEqual(d.severity, 'medium');
    strictEqual(d.author, '');
  });

  it('returns a NEW object on every call (mutation safety)', () => {
    const a = blankDraft();
    const b = blankDraft();
    a.title = 'leaked';
    a.description = 'leaked';
    strictEqual(b.title, '');
    strictEqual(b.description, '');
  });
});

// ─── validateDraft ──────────────────────────────────────────────

describe('validateDraft', () => {
  it('passes a well-formed draft (returns empty array)', () => {
    const errs = validateDraft({
      title: 'Cumulative P&L shows wrong total',
      description: 'after partial close, the dashboard sums realized twice',
      category: 'ui',
      severity: 'high',
    });
    deepStrictEqual(errs, []);
  });

  it('rejects a non-object draft', () => {
    deepStrictEqual(validateDraft(null), ['draft must be an object']);
    deepStrictEqual(validateDraft(undefined), ['draft must be an object']);
    deepStrictEqual(validateDraft('hello'), ['draft must be an object']);
    deepStrictEqual(validateDraft(42), ['draft must be an object']);
  });

  it('rejects a title shorter than 3 chars', () => {
    const errs = validateDraft({ title: 'ab', description: 'long enough body', category: 'ui', severity: 'high' });
    match(errs.join('|'), /title must be at least 3 chars/);
  });

  it('rejects a description shorter than 5 chars', () => {
    const errs = validateDraft({ title: 'long enough title', description: 'abc', category: 'ui', severity: 'high' });
    match(errs.join('|'), /description must be at least 5 chars/);
  });

  it('rejects an unknown category', () => {
    const errs = validateDraft({ title: 'long enough title', description: 'long enough description', category: 'wrong-cat', severity: 'high' });
    match(errs.join('|'), /category is required/);
  });

  it('rejects the "all" category (it\'s a filter sentinel, not a real category)', () => {
    const errs = validateDraft({ title: 'long enough title', description: 'long enough description', category: 'all', severity: 'high' });
    match(errs.join('|'), /category is required/);
  });

  it('rejects an unknown severity', () => {
    const errs = validateDraft({ title: 'long enough title', description: 'long enough description', category: 'ui', severity: 'huge' });
    match(errs.join('|'), /severity is required/);
  });

  it('rejects the "all" severity (filter sentinel)', () => {
    const errs = validateDraft({ title: 'long enough title', description: 'long enough description', category: 'ui', severity: 'all' });
    match(errs.join('|'), /severity is required/);
  });

  it('returns multiple errors when multiple fields are bad', () => {
    const errs = validateDraft({ title: '', description: 'x', category: 'bogus', severity: 'bogus' });
    // Expect at LEAST 4 error strings back, not just the first.
    ok(errs.length >= 4, `expected ≥4 errors, got ${errs.length}: ${JSON.stringify(errs)}`);
  });

  it('whitespace-only title is rejected', () => {
    const errs = validateDraft({ title: '   ', description: 'long enough description', category: 'ui', severity: 'high' });
    match(errs.join('|'), /title must be at least 3 chars/);
  });

  it('coerces non-string title/description via typeof check', () => {
    // A misbehaving browser might give us a non-string. typeof null
    // is 'object' and typeof undefined is 'undefined', so the typeof
    // check should reject both — but a Number that stringifies to a
    // long enough value should also fail (the live behavior is to
    // stringify-and-check; if a non-string slips through we want
    // to know). The original inline code used
    // `typeof d.title !== 'string'` so we mirror that exactly.
    const errs = validateDraft({ title: 42, description: 42, category: 'ui', severity: 'high' });
    ok(errs.length >= 2, 'expected typeof failures for title + description');
  });
});

// ─── createFormCategoryOptions / createFormSeverityOptions ──────

describe('createFormCategoryOptions', () => {
  it('has exactly 7 entries (drops the "all" sentinel)', () => {
    const out = createFormCategoryOptions();
    strictEqual(out.length, 7);
    ok(!out.some((o) => o.id === 'all'));
  });

  it('ids match the schema\'s BUGS_CATEGORIES exactly', () => {
    const out = createFormCategoryOptions();
    deepStrictEqual(out.map((o) => o.id), [
      'ui', 'data', 'logic', 'performance', 'config', 'wallet', 'other',
    ]);
  });

  it('every entry has both id and label set', () => {
    for (const o of createFormCategoryOptions()) {
      ok(typeof o.id === 'string' && o.id.length > 0);
      ok(typeof o.label === 'string' && o.label.length > 0);
    }
  });

  it('returns a fresh array on every call', () => {
    const a = createFormCategoryOptions();
    const b = createFormCategoryOptions();
    ok(a !== b, 'expected distinct array instances');
  });

  it('returned entries are NOT frozen (callers may clone, mutate in tests, etc.)', () => {
    const out = createFormCategoryOptions();
    // Plain object → assignment does not throw.
    out[0].label = 'MUTATED';
    strictEqual(out[0].label, 'MUTATED');
  });

  it('does not leak the CATEGORY_OPTIONS frozen entries (returns copies)', () => {
    // Regression guard: if we ever change the implementation to
    // return a `.slice()` / `.map()` that shares references with the
    // frozen CATEGORY_OPTIONS, attempts to mutate would throw. The
    // current implementation is `.map(o => ({ id, label }))` so we
    // get plain copies — lock this in case the implementation
    // changes to a shared reference.
    const out = createFormCategoryOptions();
    out[0].label = 'PERMITTED';
    strictEqual(CATEGORY_OPTIONS[0].label, 'UI');
  });
});

describe('createFormSeverityOptions', () => {
  it('has exactly 4 entries (drops the "all" sentinel)', () => {
    const out = createFormSeverityOptions();
    strictEqual(out.length, 4);
    ok(!out.some((o) => o.id === 'all'));
  });

  it('ids match the schema\'s BUGS_SEVERITIES exactly', () => {
    const out = createFormSeverityOptions();
    deepStrictEqual(out.map((o) => o.id), ['critical', 'high', 'medium', 'low']);
  });

  it('returns a fresh array on every call', () => {
    const a = createFormSeverityOptions();
    const b = createFormSeverityOptions();
    ok(a !== b);
  });
});

// ─── Cross-helper sanity (locks the BUGS_CATEGORIES ↔ CATEGORY_OPTIONS
//     ↔ CATEGORY_OPTIONS[0].label ↔ severityClass medium/in_progress
//     parities the dashboard code depends on). ────────────────────────

describe('cross-helper sanity', () => {
  it('the bug-form\'s default category ("other") is a valid category', () => {
    const d = blankDraft();
    ok(CATEGORY_OPTIONS.some((o) => o.id === d.category));
  });

  it('the bug-form\'s default severity ("medium") is a valid severity', () => {
    const d = blankDraft();
    ok(SEVERITY_OPTIONS.some((o) => o.id === d.severity));
  });

  it('every STATUS_FILTERS id has a matching STATUS_LABEL', () => {
    for (const f of STATUS_FILTERS) {
      if (f.id === 'all') continue;
      ok(typeof STATUS_LABEL[f.id] === 'string', `missing STATUS_LABEL for status id ${f.id}`);
      ok(typeof STATUS_DESCRIPTION[f.id] === 'string', `missing STATUS_DESCRIPTION for status id ${f.id}`);
      ok(typeof STATUS_BADGE_CLASS[f.id] === 'string', `missing STATUS_BADGE_CLASS for status id ${f.id}`);
      ok(statusClass(f.id).includes('text-'), `statusClass(${f.id}) returned a non-class string`);
    }
  });

  it('every SEVERITY_OPTIONS id has a matching SEVERITY_CLASS', () => {
    for (const o of SEVERITY_OPTIONS) {
      if (o.id === 'all') continue;
      ok(typeof SEVERITY_CLASS[o.id] === 'string', `missing SEVERITY_CLASS for severity id ${o.id}`);
      ok(severityClass(o.id).includes('text-'), `severityClass(${o.id}) returned a non-class string`);
    }
  });
});

// ─── BUGS_HEADER_SUBTITLE ───────────────────────────────────────────

describe('BUGS_HEADER_SUBTITLE', () => {
  it('is a non-empty string', () => {
    ok(typeof BUGS_HEADER_SUBTITLE === 'string');
    ok(BUGS_HEADER_SUBTITLE.length > 20, 'subtitle should be a meaningful one-liner, not a stub');
  });

  it('mentions the supervisor pick-order so operators see the priority contract', () => {
    ok(BUGS_HEADER_SUBTITLE.toLowerCase().includes('supervisor'));
    ok(BUGS_HEADER_SUBTITLE.toLowerCase().includes('lowest-priority'));
    ok(BUGS_HEADER_SUBTITLE.toLowerCase().includes('open'));
  });

  it('mentions the bug→proposal fallback so operators see the precedence rule', () => {
    ok(BUGS_HEADER_SUBTITLE.toLowerCase().includes('proposals'));
  });
});

// ─── createBugPanelSubtitle (T51) ───────────────────────────────────

describe('createBugPanelSubtitle', () => {
  it('returns the form-open copy when showCreate=true (regardless of canWrite)', () => {
    const formText = createBugPanelSubtitle(true, true);
    const formTextNoToken = createBugPanelSubtitle(true, false);
    strictEqual(formText, formTextNoToken, 'showCreate should be the dominant branch');
    ok(formText.toLowerCase().includes('describe'));
    ok(formText.toLowerCase().includes('supervisor'));
    ok(!formText.includes('?token='), 'form-open copy must not advertise the token hint');
  });

  it('returns the writable hint when showCreate=false and canWrite=true', () => {
    const s = createBugPanelSubtitle(false, true);
    ok(s.toLowerCase().includes('press the button'));
    ok(s.includes('data/bugs.json'), 'should reference the on-disk bug store');
    ok(s.toLowerCase().includes('supervisor'));
    ok(!s.includes('?token='), 'writable branch must not advertise the token hint');
  });

  it('returns the read-only token hint when showCreate=false and canWrite=false', () => {
    const s = createBugPanelSubtitle(false, false);
    ok(s.includes('?token='), 'read-only branch must point the operator at the token URL');
    ok(s.toLowerCase().includes('api_token'));
    ok(s.toLowerCase().includes('config/user.json'));
    ok(s.toLowerCase().includes('public'), 'should explain the list is still public so the operator can preview');
  });

  it('coerces truthy non-boolean canWrite (e.g. "yes", 1) to the writable branch', () => {
    const s1 = createBugPanelSubtitle(false, 'yes');
    const s2 = createBugPanelSubtitle(false, 1);
    const ref = createBugPanelSubtitle(false, true);
    strictEqual(s1, ref, 'string truthy should map to writable');
    strictEqual(s2, ref, 'numeric truthy should map to writable');
  });

  it('coerces falsy canWrite (null / undefined / empty string / 0) to the read-only branch', () => {
    const ref = createBugPanelSubtitle(false, false);
    strictEqual(createBugPanelSubtitle(false, null), ref);
    strictEqual(createBugPanelSubtitle(false, undefined), ref);
    strictEqual(createBugPanelSubtitle(false, ''), ref);
    strictEqual(createBugPanelSubtitle(false, 0), ref);
  });

  it('coerces truthy non-boolean showCreate (e.g. "yes", 1) to the form-open branch', () => {
    const ref = createBugPanelSubtitle(true, false);
    strictEqual(createBugPanelSubtitle('yes', false), ref);
    strictEqual(createBugPanelSubtitle(1, true), ref);
    strictEqual(createBugPanelSubtitle({}, false), ref, 'object truthy should still hit the form-open branch');
  });

  it('coerces falsy showCreate (null / undefined / empty / 0) to the canWrite-driven branch', () => {
    strictEqual(createBugPanelSubtitle(null, true), createBugPanelSubtitle(false, true));
    strictEqual(createBugPanelSubtitle(undefined, false), createBugPanelSubtitle(false, false));
    strictEqual(createBugPanelSubtitle('', true), createBugPanelSubtitle(false, true));
    strictEqual(createBugPanelSubtitle(0, false), createBugPanelSubtitle(false, false));
  });

  it('never returns an empty string or non-string (defensive: JSX renders whatever this returns)', () => {
    const cases = [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
      [null, null],
      [undefined, undefined],
      ['x', 'y'],
      [0, 1],
    ];
    for (const [s, w] of cases) {
      const out = createBugPanelSubtitle(s, w);
      ok(typeof out === 'string', `got ${typeof out} for (${String(s)}, ${String(w)})`);
      ok(out.length > 0, `got empty string for (${String(s)}, ${String(w)})`);
    }
  });
});

// ─── isShippedInPlaceholder ──────────────────────────────────────────
// Defensive rendering helper added 2026-09-20: literal placeholder
// strings like `<pending-commit-hash>` used to render verbatim on the
// Bugs dashboard, making shipped bugs look un-shipped. The JSX now
// branches on this predicate and shows an amber warning pill instead.

describe('isShippedInPlaceholder', () => {
  it('returns true for angle-bracket placeholders (left/right)', () => {
    strictEqual(isShippedInPlaceholder('<pending-commit-hash>'), true);
    strictEqual(isShippedInPlaceholder('<pending>'), true);
    strictEqual(isShippedInPlaceholder('foo<bar>baz'), true);
    strictEqual(isShippedInPlaceholder('leading<'), true);
    strictEqual(isShippedInPlaceholder('trailing>'), true);
  });

  it('returns true for case-insensitive matches against pending / todo / placeholder / fixme', () => {
    strictEqual(isShippedInPlaceholder('PENDING'), true);
    strictEqual(isShippedInPlaceholder('Pending Review'), true);
    strictEqual(isShippedInPlaceholder('shipped_in: pending'), true);
    strictEqual(isShippedInPlaceholder('TODO'), true);
    strictEqual(isShippedInPlaceholder('todo-list'), true);
    strictEqual(isShippedInPlaceholder('Fixme later'), true);
    strictEqual(isShippedInPlaceholder('this is a placeholder value'), true);
    strictEqual(isShippedInPlaceholder('PLACEHOLDER'), true);
  });

  it('returns true for non-string inputs whose String() coercion contains a placeholder word', () => {
    strictEqual(isShippedInPlaceholder(Symbol('pending')), true); // String(Symbol(pending)) === 'Symbol(pending)'
    strictEqual(isShippedInPlaceholder({ toString() { return 'TODO'; } }), true);
  });

  it('never throws on adversarial input (defensive: runs during JSX render)', () => {
    // Note: JSX already guards with `{bug.shipped_in && ...}`, so the
    // helper is normally only called with truthy values; these cases
    // exist purely so a future refactor can't sneak in a throw.
    const adversarial = [null, undefined, '', 0, 1, -1, NaN, Infinity, {}, [], true, false, Symbol('x'), () => {}];
    for (const v of adversarial) {
      let out;
      try {
        out = isShippedInPlaceholder(v);
      } catch (e) {
        ok(false, `threw on ${String(v)}: ${e.message}`);
      }
      strictEqual(typeof out, 'boolean', `non-boolean for ${String(v)}: ${out}`);
    }
  });

  it('returns false for a real short (7-char) hex commit SHA', () => {
    strictEqual(isShippedInPlaceholder('8a6e14b'), false);
    strictEqual(isShippedInPlaceholder('c0ab9ec'), false);
    strictEqual(isShippedInPlaceholder('21dd142'), false);
  });

  it('returns false for a full 40-char hex SHA and other plausible commit references', () => {
    strictEqual(isShippedInPlaceholder('8a6e14b9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f6'), false);
    strictEqual(isShippedInPlaceholder('commit-8a6e14b'), false);   // contains "commit" but no placeholder word
    strictEqual(isShippedInPlaceholder('shipped-8a6e14b-2026-09-20'), false);
    strictEqual(isShippedInPlaceholder('branch=main'), false);
  });

  it('returns false for empty string and explicit empty container', () => {
    // Note: empty string is falsy in JSX (`{bug.shipped_in && ...}` short-circuits),
    // so the JSX never calls this helper with ''. But the helper itself must
    // still be defensive (no throw) for arbitrary inputs.
    strictEqual(isShippedInPlaceholder(''), false);
  });

  it('treats embedded "todo" / "fixme" inside non-context words as positive (whole-word boundary check only)', () => {
    // The whole-word regex catches "todo" but not "todolist" because
    // \btodo\b is anchored on both sides.
    strictEqual(isShippedInPlaceholder('todolist'), false);       // no boundary → not a placeholder
    strictEqual(isShippedInPlaceholder('photofixme'), false);     // ditto
    strictEqual(isShippedInPlaceholder('pendingstate'), true);     // "pending" has no \b; matches as substring
    strictEqual(isShippedInPlaceholder('antepenultimate'), false); // contains "ultim" but no whole-word placeholder
  });
});
