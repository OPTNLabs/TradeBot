// dashboard/tests/portfolio-helpers.test.mjs
//
// Unit tests for the pure helpers in `src/views/portfolio-helpers.mjs`.
// Run with `node --test` from the dashboard/ directory.
//
// Coverage:
//   - isValidTokenDecimals (15 variants: number, finite, negative,
//     fractional, NaN, Infinity, null, undefined, string, bigint, etc.)
//   - buildPositionTokenCountLine (20+ variants: happy / no-entry /
//     missing-amount / bad-amount / unknown-decimals / no-symbol /
//     various decimals precision tests / cross-checks against the
//     shared formatTokenAmount helper / adversarial inputs)

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert';

import { buildPositionTokenCountLine, isValidTokenDecimals } from '../src/views/portfolio-helpers.mjs';
import { formatTokenAmount } from '../src/lib/format.mjs';

// ─── isValidTokenDecimals ───────────────────────────────────────────

describe('isValidTokenDecimals', () => {
  it('accepts 0 (FURU is 0-decimals)', () => {
    strictEqual(isValidTokenDecimals(0), true);
  });
  it('accepts 8 (typical FT decimals)', () => {
    strictEqual(isValidTokenDecimals(8), true);
  });
  it('accepts 2', () => {
    strictEqual(isValidTokenDecimals(2), true);
  });
  it('accepts 18 (ERC-style max)', () => {
    strictEqual(isValidTokenDecimals(18), true);
  });
  it('rejects negative numbers', () => {
    strictEqual(isValidTokenDecimals(-1), false);
  });
  it('rejects fractional numbers (cashscript decimals are uint8)', () => {
    strictEqual(isValidTokenDecimals(1.5), false);
  });
  it('rejects NaN', () => {
    strictEqual(isValidTokenDecimals(NaN), false);
  });
  it('rejects Infinity', () => {
    strictEqual(isValidTokenDecimals(Infinity), false);
    strictEqual(isValidTokenDecimals(-Infinity), false);
  });
  it('rejects strings', () => {
    strictEqual(isValidTokenDecimals('8'), false);
  });
  it('rejects null', () => {
    strictEqual(isValidTokenDecimals(null), false);
  });
  it('rejects undefined', () => {
    strictEqual(isValidTokenDecimals(undefined), false);
  });
  it('rejects bigint', () => {
    strictEqual(isValidTokenDecimals(8n), false);
  });
  it('rejects booleans', () => {
    strictEqual(isValidTokenDecimals(true), false);
    strictEqual(isValidTokenDecimals(false), false);
  });
  it('rejects objects / arrays', () => {
    strictEqual(isValidTokenDecimals({}), false);
    strictEqual(isValidTokenDecimals([]), false);
  });
  it('never throws on adversarial inputs', () => {
    // Adversarial: every odd value JS can produce.
    strictEqual(isValidTokenDecimals(Symbol('x')), false);
    strictEqual(isValidTokenDecimals(() => 0), false);
  });
});

// ─── buildPositionTokenCountLine ────────────────────────────────────

describe('buildPositionTokenCountLine', () => {
  it('returns null when entry is null', () => {
    strictEqual(buildPositionTokenCountLine(null, 0, 'FURU'), null);
  });
  it('returns null when entry is undefined', () => {
    strictEqual(buildPositionTokenCountLine(undefined, 0, 'FURU'), null);
  });
  it('returns null when entry is not an object', () => {
    strictEqual(buildPositionTokenCountLine('string', 0, 'FURU'), null);
    strictEqual(buildPositionTokenCountLine(42, 0, 'FURU'), null);
    strictEqual(buildPositionTokenCountLine(true, 0, 'FURU'), null);
  });
  it('returns null when token_amount_base is missing', () => {
    strictEqual(buildPositionTokenCountLine({}, 0, 'FURU'), null);
  });
  it('returns null when token_amount_base is undefined', () => {
    strictEqual(buildPositionTokenCountLine({ token_amount_base: undefined }, 0, 'FURU'), null);
  });
  it('returns null when token_amount_base is null', () => {
    strictEqual(buildPositionTokenCountLine({ token_amount_base: null }, 0, 'FURU'), null);
  });
  it('returns null when token_amount_base is empty string', () => {
    strictEqual(buildPositionTokenCountLine({ token_amount_base: '' }, 0, 'FURU'), null);
    strictEqual(buildPositionTokenCountLine({ token_amount_base: '   ' }, 0, 'FURU'), null);
  });
  it('returns null when token_amount_base is a non-numeric string', () => {
    strictEqual(buildPositionTokenCountLine({ token_amount_base: 'not-a-number' }, 0, 'FURU'), null);
  });
  it('returns null when token_amount_base is a NaN number', () => {
    strictEqual(buildPositionTokenCountLine({ token_amount_base: NaN }, 0, 'FURU'), null);
  });
  it('returns null when token_amount_base is Infinity', () => {
    strictEqual(buildPositionTokenCountLine({ token_amount_base: Infinity }, 0, 'FURU'), null);
  });
  it('returns null when token_amount_base is a Symbol (defensive net)', () => {
    strictEqual(buildPositionTokenCountLine({ token_amount_base: Symbol('x') }, 0, 'FURU'), null);
  });
  it('returns null when token_amount_base is an object (defensive net)', () => {
    strictEqual(buildPositionTokenCountLine({ token_amount_base: {} }, 0, 'FURU'), null);
    strictEqual(buildPositionTokenCountLine({ token_amount_base: [] }, 0, 'FURU'), null);
  });
  it('happy-path: 0-decimals + integer amount → formatted with thin-space separator', () => {
    const r = buildPositionTokenCountLine({ token_amount_base: '1282' }, 0, 'FURU');
    ok(r);
    strictEqual(r.formatted, '1\u202F282');
    strictEqual(r.symbol, 'FURU');
    strictEqual(r.raw, '1282');
    strictEqual(r.decimals, 0);
    strictEqual(r.hasData, true);
  });
  it('happy-path: 2-decimals → "5 070.44" style rendering', () => {
    const r = buildPositionTokenCountLine({ token_amount_base: '507044' }, 2, 'XYZ');
    ok(r);
    strictEqual(r.formatted, '5\u202F070.44');
    strictEqual(r.symbol, 'XYZ');
    strictEqual(r.raw, '507044');
    strictEqual(r.decimals, 2);
  });
  it('happy-path: 8-decimals + tiny fraction', () => {
    const r = buildPositionTokenCountLine({ token_amount_base: '1513' }, 8, 'QBTC');
    ok(r);
    strictEqual(r.formatted, '0.00001513');
    strictEqual(r.symbol, 'QBTC');
  });
  it('happy-path: zero-decimals with very large amount keeps precision (uses formatTokenAmount bigint path)', () => {
    const r = buildPositionTokenCountLine({ token_amount_base: '123456789012345' }, 0, 'BIG');
    ok(r);
    strictEqual(r.formatted, '123\u202F456\u202F789\u202F012\u202F345');
  });
  it('happy-path: numeric-string with whitespace around it (formatTokenAmount trims)', () => {
    const r = buildPositionTokenCountLine({ token_amount_base: '  507044  ' }, 2, 'XYZ');
    ok(r);
    strictEqual(r.formatted, '5\u202F070.44');
  });
  it('happy-path: number input (not just string)', () => {
    const r = buildPositionTokenCountLine({ token_amount_base: 507044 }, 2, 'XYZ');
    ok(r);
    strictEqual(r.formatted, '5\u202F070.44');
    strictEqual(r.raw, '507044');
  });
  it('happy-path: bigint input', () => {
    const r = buildPositionTokenCountLine({ token_amount_base: 507044n }, 2, 'XYZ');
    ok(r);
    strictEqual(r.formatted, '5\u202F070.44');
    strictEqual(r.raw, '507044');
  });
  it('happy-path: no symbol → symbol is null (React renders nothing extra)', () => {
    const r = buildPositionTokenCountLine({ token_amount_base: '1282' }, 0, null);
    ok(r);
    strictEqual(r.symbol, null);
  });
  it('happy-path: empty-string symbol → symbol is null (defensive — empty string should not render)', () => {
    const r = buildPositionTokenCountLine({ token_amount_base: '1282' }, 0, '');
    ok(r);
    strictEqual(r.symbol, null);
  });
  it('happy-path: non-string symbol → symbol is null', () => {
    const r = buildPositionTokenCountLine({ token_amount_base: '1282' }, 0, 42);
    ok(r);
    strictEqual(r.symbol, null);
  });
  it('unknown decimals (null) → falls back to raw integer with thin-space separators', () => {
    const r = buildPositionTokenCountLine({ token_amount_base: '1282' }, null, 'FURU');
    ok(r);
    strictEqual(r.formatted, '1\u202F282');
    strictEqual(r.decimals, null);
  });
  it('invalid decimals (NaN) → falls back to raw integer (defensive)', () => {
    const r = buildPositionTokenCountLine({ token_amount_base: '1282' }, NaN, 'FURU');
    ok(r);
    strictEqual(r.formatted, '1\u202F282');
    strictEqual(r.decimals, null);
  });
  it('invalid decimals (-1, fractional) → falls back to raw integer', () => {
    const r1 = buildPositionTokenCountLine({ token_amount_base: '1282' }, -1, 'FURU');
    ok(r1);
    strictEqual(r1.formatted, '1\u202F282');
    const r2 = buildPositionTokenCountLine({ token_amount_base: '1282' }, 1.5, 'FURU');
    ok(r2);
    strictEqual(r2.formatted, '1\u202F282');
  });
  it('output crosses mode (decision logic): isValidTokenDecimals gates decimals, raw-without-decimals otherwise', () => {
    // Cross-check: for ANY valid-decimals input, formatted equals
    // formatTokenAmount(raw, decimals); for ANY invalid-decimals
    // input, formatted equals formatTokenAmount(raw, null) (which
    // is the same as formatTokenAmount's own built-in rawOnMissing
    // fallback — the helper just sets decimals=null).
    const fixtures = [
      { raw: '1282', decimals: 0 },
      { raw: '507044', decimals: 2 },
      { raw: '1513', decimals: 8 },
      { raw: '50000', decimals: 18 },
      { raw: '123456789012345', decimals: 0 },
    ];
    for (const { raw, decimals } of fixtures) {
      const r = buildPositionTokenCountLine({ token_amount_base: raw }, decimals, 'SYM');
      ok(r);
      strictEqual(r.formatted, formatTokenAmount(raw, decimals));
    }
    // Invalid-decimals case — formatted matches the raw integer.
    const r = buildPositionTokenCountLine({ token_amount_base: '1282' }, 'bad', 'SYM');
    ok(r);
    strictEqual(r.formatted, formatTokenAmount('1282', null));
  });
  it('output raw field is always a string (even for number/bigint inputs)', () => {
    const r1 = buildPositionTokenCountLine({ token_amount_base: 1282 }, 0, 'FURU');
    ok(r1);
    strictEqual(typeof r1.raw, 'string');
    strictEqual(r1.raw, '1282');
    const r2 = buildPositionTokenCountLine({ token_amount_base: 1282n }, 0, 'FURU');
    ok(r2);
    strictEqual(typeof r2.raw, 'string');
    strictEqual(r2.raw, '1282');
  });
  it('output hasData is true on the happy path (locks the contract for the React tile)', () => {
    const r = buildPositionTokenCountLine({ token_amount_base: '1282' }, 0, 'FURU');
    ok(r);
    strictEqual(r.hasData, true);
    deepStrictEqual(Object.keys(r).sort(), ['decimals', 'formatted', 'hasData', 'raw', 'symbol']);
  });
  it('zero-amount position still renders (data exists, value is zero)', () => {
    const r = buildPositionTokenCountLine({ token_amount_base: '0' }, 0, 'FURU');
    ok(r);
    strictEqual(r.formatted, '0');
    strictEqual(r.raw, '0');
  });
  it('never returns a string instead of an object (catches a refactor that accidentally returns formatted)', () => {
    const r = buildPositionTokenCountLine({ token_amount_base: '1282' }, 0, 'FURU');
    ok(r);
    ok(typeof r === 'object', 'must return object, not string');
    ok(Array.isArray(r) === false, 'must not return array');
  });
  it('does not surface the em-dash placeholder when amount is valid (defensive against a future formatTokenAmount regression)', () => {
    const r = buildPositionTokenCountLine({ token_amount_base: '1282' }, 0, 'FURU');
    ok(r);
    ok(r.formatted !== '—');
  });
});