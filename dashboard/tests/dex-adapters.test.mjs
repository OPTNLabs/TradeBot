#!/usr/bin/env node
// dashboard/tests/dex-adapters.test.mjs
//
// T86 — Unit tests for `dashboard/src/lib/dex-adapters.mjs`.
//
// The dashboard imports the DEX id registry from a browser-safe
// mirror at `dashboard/src/lib/dex-adapters.mjs` (NOT from the
// server-side `src/dex/adapter.mjs`, which transitively pulls in
// node:fs / node:path). The mirror exports `KNOWN_DEX_IDS` as a
// FROZEN ARRAY — but Settings.jsx imports it under the alias
// `listKnownDexIds` for readability. Calling the alias as a
// function (`listKnownDexIds()`) crashes the Settings page with
// "TypeError: <arr> is not a function" (minified: "gre is not a
// function"). This test file locks in the contract that
// `KNOWN_DEX_IDS` is an array, not a function, so the Settings
// page can rely on the alias being array-shaped.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual, throws } from 'node:assert';

import { KNOWN_DEX_IDS } from '../src/lib/dex-adapters.mjs';

describe('KNOWN_DEX_IDS (browser-safe DEX id mirror)', () => {
  it('exports a frozen array (NOT a function — Settings.jsx uses it as an array)', () => {
    strictEqual(typeof KNOWN_DEX_IDS, 'object',
      `KNOWN_DEX_IDS must be an array (typeof 'object' + Array.isArray), not a function (got typeof=${typeof KNOWN_DEX_IDS})`);
    ok(Array.isArray(KNOWN_DEX_IDS),
      `KNOWN_DEX_IDS must be an array (Array.isArray must return true)`);
    throws(() => KNOWN_DEX_IDS(),
      /not a function|TypeError/,
      `calling KNOWN_DEX_IDS() must throw — it's an array, not a function. A regression here would crash the Settings page.`);
  });

  it('is frozen (cannot be mutated by the dashboard)', () => {
    strictEqual(Object.isFrozen(KNOWN_DEX_IDS), true,
      'KNOWN_DEX_IDS must be frozen so the dashboard cannot mutate the canonical order');
  });

  it('contains the expected DEX ids in registry order', () => {
    deepStrictEqual([...KNOWN_DEX_IDS], ['cauldron', 'cauldron_safe_mode', 'guanaco'],
      'KNOWN_DEX_IDS must mirror src/dex/adapter.mjs#DEX_REGISTRY in canonical order. Adding a new adapter = add it to BOTH files in the same position.');
  });

  it('contains only non-empty strings (no nulls / undefined / blank)', () => {
    for (const id of KNOWN_DEX_IDS) {
      strictEqual(typeof id, 'string', `every entry must be a string (got ${typeof id}: ${id})`);
      ok(id.length > 0, `every entry must be non-empty (got "${id}")`);
    }
  });
});
