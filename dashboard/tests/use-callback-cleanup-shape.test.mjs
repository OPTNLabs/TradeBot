#!/usr/bin/env node
// dashboard/tests/use-callback-cleanup-shape.test.mjs
//
// Regression test for the "TypeError: n is not a function" /
// "blank-black-screen-after-20-seconds" bug introduced by T88
// and shipped across LifestoneLabs/TradeBot commits f3c8d06,
// 996d543, etc. (operator-flagged 2026-09-21 via Telegram
// ~13:10 PDT after the dashboard went black 20s in).
//
// Bug pattern: a `useCallback(async ())` whose body returns a
// cleanup arrow function. Async functions wrap their return in
// a Promise, so the cleanup arrow is the Promise's resolved
// value — NOT the function caller's return value. If the
// surrounding `useEffect` does `const cleanup = refresh(); return
// cleanup;`, React sees a Promise (not a function), silently
// drops cleanup, the cancellation flag never fires, and stale
// fetches eventually clobber newer state on re-render with an
// undefined-property crash.
//
// Fix pattern: `useCallback(() => { ... return () => {...}; })` —
// no async, the IIFE is inline, the cleanup is the function's
// immediate return value. `useEffect` then does
// `useEffect(() => refresh(), [deps])`.
//
// This test scans `dashboard/src/components/*.jsx` for the BAD
// pattern. A future card (or a refactor that re-introduces the
// pattern on an existing card) fails the test loudly.
//
// What it does NOT scan:
//   - `useCallback(async ())` handlers that are NOT called via
//     useEffect (e.g. event-handler `onCopy` / `onClick`). Those
//     are safe — the cleanup pattern only matters inside
//     useEffect.
//   - `useCallback(async ())` inside `lookup` / `openDetail` /
//     etc. — same reason.
//   - Cards that correctly use the non-async `useCallback(() =>
//     {...}) -> IIFE -> return () => { cancelled = true; }`
//     shape.
//
// Run with:
//   node --test dashboard/tests/use-callback-cleanup-shape.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPONENTS_DIR = path.resolve(HERE, '..', 'src', 'components');

/**
 * Strip the body of `useEffect` calls from the source, so we
 * don't false-positive on safe `useCallback(async)` event
 * handlers. We grep for `useEffect` then take everything between
 * its opening `(` and the matching closing `)`; that substring
 * is where the bug lives.
 *
 * @param {string} src
 * @returns {string} useEffect-substring-only source
 */
function extractUseEffectBodies(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const idx = src.indexOf('useEffect', i);
    if (idx < 0) break;
    // Find the opening `(` after `useEffect`. Skip whitespace.
    let j = idx + 'useEffect'.length;
    while (j < src.length && /\s/.test(src[j])) j++;
    if (src[j] !== '(') { i = j; continue; }

    // Track paren depth to find the matching `)`.
    let depth = 1;
    j++;
    while (j < src.length && depth > 0) {
      const c = src[j];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === '"' || c === "'" || c === '`') {
        // skip over the string literal
        const quote = c;
        j++;
        while (j < src.length && src[j] !== quote) {
          if (src[j] === '\\') j++;
          j++;
        }
      }
      else if (c === '/' && src[j + 1] === '/') {
        while (j < src.length && src[j] !== '\n') j++;
      }
      else if (c === '/' && src[j + 1] === '*') {
        j += 2;
        while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j++;
        j += 2;
      }
      j++;
    }
    out.push(src.slice(idx, j));
    i = j;
  }
  return out.join('\n');
}

/**
 * Find every `useCallback(async ...) ... { body } ...` block in
 * source, returning each body. Walks the AST naïvely: after the
 * `useCallback(async (` prefix, we step through the parameter
 * list tracking paren depth (so `{ forcePreview = false } = {}`
 * destructuring doesn't confuse us), then expect the `=> {`
 * token, then capture everything up to the matching `}` (with
 * depth tracking to handle nested blocks).
 *
 * @param {string} src
 */
function extractAsyncUseCallbackBodies(src) {
  const out = [];
  // Match `useCallback(async ` (with whatever whitespace). The
  // async keyword is mandatory for the bug class.
  const re = /useCallback\(\s*async\s+/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = m.index;

    // After `useCallback(async ` we're at the start of the
    // parameter list (e.g. `({ forcePreview = false } = {})`).
    // Walk paren depth (and skip over string/comment literals
    // same as extractUseEffectBodies).
    let j = m.index + m[0].length;

    // skip optional whitespace
    while (j < src.length && /\s/.test(src[j])) j++;

    // Expect the parameter list. Could be `(...)` (named) or
    // `()` (no params). Track depth until we hit the closing
    // paren.
    if (src[j] !== '(') {
      // malformed — skip
      continue;
    }
    let parenDepth = 1;
    j++;
    while (j < src.length && parenDepth > 0) {
      const c = src[j];
      if (c === '(') parenDepth++;
      else if (c === ')') parenDepth--;
      else if (c === '{' || c === '[') {
        // could be a nested param-destructuring block — track
        // loosely so `{ x } = ...` doesn't confuse us
        const open = c;
        const close = c === '{' ? '}' : ']';
        let bracketDepth = 1;
        j++;
        while (j < src.length && bracketDepth > 0) {
          if (src[j] === open) bracketDepth++;
          else if (src[j] === close) bracketDepth--;
          j++;
        }
        continue;
      }
      else if (c === '"' || c === "'" || c === '`') {
        const quote = c;
        j++;
        while (j < src.length && src[j] !== quote) {
          if (src[j] === '\\') j++;
          j++;
        }
        j++;
        continue;
      }
      j++;
    }
    // j is now just past the closing `)` of the param list.

    // Expect whitespace then `=>`. We don't enforce this; if
    // it's an arrow function it should be there.
    while (j < src.length && /\s/.test(src[j])) j++;
    if (src.slice(j, j + 2) !== '=>') {
      // not an arrow function — skip
      continue;
    }
    j += 2;
    while (j < src.length && /\s/.test(src[j])) j++;

    // Expect `{` (arrow-body). If it's `(` (concise body), skip.
    if (src[j] !== '{') {
      continue;
    }
    const bodyStart = j;
    let bodyDepth = 0;
    while (j < src.length) {
      const c = src[j];
      if (c === '{') bodyDepth++;
      else if (c === '}') {
        bodyDepth--;
        if (bodyDepth === 0) {
          out.push(src.slice(bodyStart, j + 1));
          break;
        }
      }
      else if (c === '"' || c === "'" || c === '`') {
        const quote = c;
        j++;
        while (j < src.length && src[j] !== quote) {
          if (src[j] === '\\') j++;
          j++;
        }
      }
      j++;
    }
  }
  return out;
}

test('useCallback-cleanup-shape: scans dashboard/src/components/*.jsx', () => {
  const files = readdirSync(COMPONENTS_DIR).filter((f) => f.endsWith('.jsx'));
  assert.ok(files.length >= 5, `expected at least 5 .jsx files under ${COMPONENTS_DIR}, got ${files.length}`);
});

test('useCallback-cleanup-shape: no async useCallback body that returns a cleanup arrow into a useEffect', () => {
  const files = readdirSync(COMPONENTS_DIR).filter((f) => f.endsWith('.jsx'));
  const offenders = [];

  for (const f of files) {
    const src = readFileSync(path.join(COMPONENTS_DIR, f), 'utf8');
    const useEffectBodies = extractUseEffectBodies(src);
    // We use a multi-pass scan: each useEffect body may have a
    // `const cleanup = refresh()` (or similar) referencing a
    // async useCallback. The dangerous combo is:
    //
    //   useEffect(() => {
    //     const cleanup = refresh();   // returns Promise
    //     return cleanup;              // useEffect gets Promise
    //   }, [refresh, tick]);
    //
    // We approximate by checking: does the useEffect body
    // reference any `useCallback(async ...)`-derived function
    // (any identifier matching `refresh`, `refreshLog`,
    // `refreshRollup`, `lookup`, etc.) — AND does that body's
    // source mention `return cleanup;` (the bad wrapper)?
    //
    // The precise check: for every useEffect body that contains
    // `return cleanup;`, the *file* (or the surrounding context)
    // must NOT contain a `useCallback(async)` declaration whose
    // body ends with `return () => { ... cancelled = true; };`.
    //
    // Simpler proxy: count `useCallback(async ...)` declarations
    // whose body looks like the bug pattern. Any count > 0 is a
    // fail.
    const asyncBodies = extractAsyncUseCallbackBodies(src);
    for (const body of asyncBodies) {
      // Did the body return a cleanup arrow?
      if (/return\s+\(\s*\)\s*=>\s*\{/.test(body) || /return\s*\(?\s*\(\s*\)\s*=>\s*\{/.test(body)) {
        offenders.push(`${f}: async useCallback body returns a '() => { ... }' cleanup arrow`);
      }
    }
  }

  if (offenders.length > 0) {
    assert.fail(
      'Found async useCallback bodies that return a cleanup arrow.\n'
      + 'The Promise-returning useEffect pattern causes "TypeError: n is not a function"\n'
      + 'and a blank-black-page ~20s after dashboard load. Replace with the non-async\n'
      + '`useCallback(() => { ... IIFE ... return () => { cancelled = true; }; })` shape.\n\n'
      + 'Offenders:\n  - ' + offenders.join('\n  - ')
    );
  }
});

test('useCallback-cleanup-shape: every useEffect body that does `return cleanup;` calls a non-async function', () => {
  const files = readdirSync(COMPONENTS_DIR).filter((f) => f.endsWith('.jsx'));
  const offenders = [];

  for (const f of files) {
    const src = readFileSync(path.join(COMPONENTS_DIR, f), 'utf8');
    const useEffectBodies = extractUseEffectBodies(src);
    for (const body of useEffectBodies) {
      // Match the dangerous pattern: useEffect body that does
      // `const cleanup = <X>()` AND `return cleanup;` (or
      // `return refresh()` directly) where the file has a
      // `useCallback(async ...)` for the same identifier.
      if (!/return\s+cleanup\s*;/.test(body) && !/return\s+refresh\w*\(\)/.test(body)) {
        continue;
      }
      // Does the file have any async useCallback (which would
      // be the bug source)?
      if (/useCallback\(\s*async\s*\(/.test(src)) {
        offenders.push(`${f}: useEffect body uses 'return cleanup;' but file contains useCallback(async)`);
      }
    }
  }

  if (offenders.length > 0) {
    assert.fail(
      'Found useEffect bodies that return a Promise-resolved cleanup.\n'
      + 'Fix: change useCallback(async ...) to useCallback(() => ...) and inline the IIFE.\n\n'
      + 'Offenders:\n  - ' + offenders.join('\n  - ')
    );
  }
});

test('useCallback-cleanup-shape: at least one card uses the safe pattern (sanity)', () => {
  // We expect at least SnapshotStatsCard / StakingStatusCard /
  // TokenSummaryCard / MetricsViewerCard / FeeBreakdownCard to
  // have the safe (non-async) `useCallback(() => { ... return
  // () => { cancelled = true; }; })` pattern. If this count
  // drops below 3, the test fails as a sanity check that the
  // scanner is actually scanning the expected files.
  const files = readdirSync(COMPONENTS_DIR).filter((f) => f.endsWith('.jsx'));
  let safeCount = 0;
  for (const f of files) {
    const src = readFileSync(path.join(COMPONENTS_DIR, f), 'utf8');
    // Safe pattern signature in a single file (when concatenated):
    //   useCallback\(
    //   ... let cancelled = false;
    //   ... (async () => {
    //   ... })();
    //   ... return () => { ...; cancelled = true; };
    // We approximate with three loose regexes that must all hit.
    if (/useCallback\(\s*\(/.test(src)
        && /\(async\s*\(\s*\)\s*=>\s*\{/.test(src)
        && /return\s+\(\s*\)\s*=>\s*\{[^}]*cancelled\s*=\s*true/.test(src)) {
      safeCount++;
    }
  }
  assert.ok(safeCount >= 3,
    `expected at least 3 cards using the safe pattern, found ${safeCount}. `
    + `If the safe pattern was removed from all cards intentionally, this sanity test needs updating.`);
});

test('useCallback-cleanup-shape: file count + sizes look sane', () => {
  const files = readdirSync(COMPONENTS_DIR).filter((f) => f.endsWith('.jsx'));
  for (const f of files) {
    const stat = statSync(path.join(COMPONENTS_DIR, f));
    // No card should be > 50 KB (would suggest copy-paste bloat).
    assert.ok(stat.size < 50_000, `${f} is ${stat.size} bytes — suspiciously large`);
    // No card should be < 500 bytes (would suggest truncation).
    assert.ok(stat.size > 500, `${f} is ${stat.size} bytes — suspiciously small`);
  }
});
