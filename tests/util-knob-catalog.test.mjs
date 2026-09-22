#!/usr/bin/env node
/**
 * Unit tests for src/util/knob-catalog.mjs.
 *
 * Tests: KNOBS shape, lookupKnobMeta, lookupKnobByKey,
 * knobsRequiringRestart, validateKnobValueForServer,
 * T46b new knobs present.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  KNOBS,
  lookupKnobMeta,
  lookupKnobByKey,
  knobsRequiringRestart,
  validateKnobValueForServer,
} from '../src/util/knob-catalog.mjs';

// ────────────────────────────────────────────────────────────────────
//  KNOBS shape
// ────────────────────────────────────────────────────────────────────

test('KNOBS: is a frozen non-empty array', () => {
  assert.ok(Array.isArray(KNOBS), 'KNOBS must be an array');
  assert.ok(KNOBS.length > 50, `expected >50 knobs, got ${KNOBS.length}`); // T43 had ~50
  assert.ok(Object.isFrozen(KNOBS), 'KNOBS must be frozen');
});

test('KNOBS: every entry has required fields', () => {
  for (const k of KNOBS) {
    assert.ok('key' in k, `knob missing key: ${JSON.stringify(k)}`);
    assert.ok('path' in k, `knob missing path: ${JSON.stringify(k)}`);
    assert.ok('label' in k, `knob missing label: ${JSON.stringify(k)}`);
    assert.ok('restart' in k, `knob missing restart: ${JSON.stringify(k)}`);
    assert.ok('description' in k, `knob missing description: ${JSON.stringify(k)}`);
    assert.ok('group' in k, `knob missing group: ${JSON.stringify(k)}`);
    assert.ok(Array.isArray(k.path), `path must be array: ${JSON.stringify(k)}`);
    assert.ok(k.path.length > 0, `path must be non-empty: ${JSON.stringify(k)}`);
    assert.equal(k.key, k.path.join('.'), `key must match path.join('.'): ${JSON.stringify(k)}`);
  }
});

test('KNOBS: every key is unique', () => {
  const keys = KNOBS.map((k) => k.key);
  const unique = new Set(keys);
  assert.equal(unique.size, keys.length, 'duplicate knob keys found');
});

// ────────────────────────────────────────────────────────────────────
//  lookupKnobMeta
// ────────────────────────────────────────────────────────────────────

test('lookupKnobMeta: returns null for unknown path', () => {
  assert.equal(lookupKnobMeta('not.a.real.path'), null);
  assert.equal(lookupKnobMeta(['not', 'a', 'real', 'path']), null);
});

test('lookupKnobMeta: resolves dotted key (string)', () => {
  const m = lookupKnobMeta('scoring.weights.volume_24h_bch');
  assert.ok(m, 'expected to find scoring.weights.volume_24h_bch');
  assert.equal(m.kind, 'number');
  assert.equal(m.restart, true);
});

test('lookupKnobMeta: resolves array path', () => {
  const m = lookupKnobMeta(['scoring', 'weights', 'volume_24h_bch']);
  assert.ok(m, 'expected to find scoring.weights.volume_24h_bch via array path');
});

test('lookupKnobMeta: resolves every KNOBS entry', () => {
  for (const k of KNOBS) {
    const found = lookupKnobMeta(k.key);
    assert.ok(found, `expected to find ${k.key}`);
    assert.equal(found.key, k.key);
  }
});

// ────────────────────────────────────────────────────────────────────
//  lookupKnobByKey
// ────────────────────────────────────────────────────────────────────

test('lookupKnobByKey: returns null for non-string', () => {
  assert.equal(lookupKnobByKey(null), null);
  assert.equal(lookupKnobByKey(undefined), null);
  assert.equal(lookupKnobByKey(42), null);
  assert.equal(lookupKnobByKey({}), null);
});

test('lookupKnobByKey: returns null for empty string', () => {
  assert.equal(lookupKnobByKey(''), null);
});

test('lookupKnobByKey: rejects path traversal attempts', () => {
  assert.equal(lookupKnobByKey('../etc/passwd'), null);
  assert.equal(lookupKnobByKey('foo/../bar'), null);
  assert.equal(lookupKnobByKey('foo\\..\\bar'), null);
});

test('lookupKnobByKey: resolves every KNOBS entry', () => {
  for (const k of KNOBS) {
    const found = lookupKnobByKey(k.key);
    assert.ok(found, `expected to find ${k.key}`);
    assert.equal(found.key, k.key);
  }
});

// ────────────────────────────────────────────────────────────────────
//  knobsRequiringRestart
// ────────────────────────────────────────────────────────────────────

test('knobsRequiringRestart: returns every restart:true knob by default', () => {
  const restartKnobs = knobsRequiringRestart();
  const restartKeys = restartKnobs.sort();
  const allKeys = KNOBS.filter((k) => k.restart).map((k) => k.key).sort();
  assert.deepEqual(restartKeys, allKeys);
});

test('knobsRequiringRestart: returns subset when keys arg given', () => {
  const subset = knobsRequiringRestart(['scoring.weights.volume_24h_bch', 'entry.max_position_bch']);
  assert.deepEqual(subset.sort(), ['entry.max_position_bch', 'scoring.weights.volume_24h_bch']);
});

// ────────────────────────────────────────────────────────────────────
//  validateKnobValueForServer
// ────────────────────────────────────────────────────────────────────

test('validateKnobValueForServer: returns ok=true for valid number within bounds', () => {
  const meta = lookupKnobByKey('entry.max_position_bch');
  const r = validateKnobValueForServer(meta, 0.005);
  assert.equal(r.ok, true);
  assert.equal(r.normalized, 0.005);
  assert.equal(r.reason, 'ok');
});

test('validateKnobValueForServer: coerces numeric string', () => {
  const meta = lookupKnobByKey('entry.max_position_bch');
  const r = validateKnobValueForServer(meta, '0.005');
  assert.equal(r.ok, true);
  assert.equal(r.normalized, 0.005);
});

test('validateKnobValueForServer: rejects non-finite number', () => {
  const meta = lookupKnobByKey('entry.max_position_bch');
  const r = validateKnobValueForServer(meta, NaN);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'nan');
});

test('validateKnobValueForServer: rejects below min', () => {
  const meta = lookupKnobByKey('entry.max_position_bch'); // min=0.0001
  const r = validateKnobValueForServer(meta, 0.00001);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'below_min');
});

test('validateKnobValueForServer: rejects above max', () => {
  const meta = lookupKnobByKey('entry.max_position_bch'); // max=1.0
  const r = validateKnobValueForServer(meta, 2.0);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'above_max');
});

test('validateKnobValueForServer: boolean knob — accepts true/false', () => {
  const meta = lookupKnobByKey('entry.use_post_trade_check');
  assert.equal(validateKnobValueForServer(meta, true).ok, true);
  assert.equal(validateKnobValueForServer(meta, false).ok, true);
  assert.equal(validateKnobValueForServer(meta, 'true').ok, true);
  assert.equal(validateKnobValueForServer(meta, 'false').ok, true);
  assert.equal(validateKnobValueForServer(meta, 'yes').ok, false);
});

test('validateKnobValueForServer: text knob — rejects empty string', () => {
  const meta = lookupKnobByKey('dashboard.bind_host');
  assert.equal(validateKnobValueForServer(meta, '').ok, false);
  assert.equal(validateKnobValueForServer(meta, '127.0.0.1').ok, true);
});

test('validateKnobValueForServer: returns null meta gracefully', () => {
  const r = validateKnobValueForServer(null, 5);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'kind_mismatch');
});

// ────────────────────────────────────────────────────────────────────
//  T46b new knobs
// ────────────────────────────────────────────────────────────────────

test('T46b: scoring.weights.volume_30d_bch is present in catalog', () => {
  const m = lookupKnobByKey('scoring.weights.volume_30d_bch');
  assert.ok(m, 'scoring.weights.volume_30d_bch must be in catalog');
  assert.equal(m.kind, 'number');
  assert.equal(m.unit, 'weight');
  assert.equal(m.restart, true);
  assert.equal(m.group, 'scoring');
  // weight knobs have min=0, max=5
  assert.equal(typeof m.min, 'number');
  assert.equal(typeof m.max, 'number');
});

test('T46b: scoring.min_volume_30d_bch is present in catalog', () => {
  const m = lookupKnobByKey('scoring.min_volume_30d_bch');
  assert.ok(m, 'scoring.min_volume_30d_bch must be in catalog');
  assert.equal(m.kind, 'number');
  assert.equal(m.unit, 'BCH');
  assert.equal(m.restart, true);
  // min=0 (can be disabled), max=10000
  assert.equal(m.min, 0);
  assert.equal(m.max, 10000);
});

test('T46b: scoring.caps.volume_30d_bch is present in catalog', () => {
  const m = lookupKnobByKey('scoring.caps.volume_30d_bch');
  assert.ok(m, 'scoring.caps.volume_30d_bch must be in catalog');
  assert.equal(m.kind, 'number');
  assert.equal(m.unit, 'BCH');
  assert.equal(m.restart, true);
  // The cap default is 200 BCH — it's reasonable to expect it in range.
  assert.equal(typeof m.max, 'number');
  assert.ok(m.max >= 200);
});

test('T46b: scoring.linear_caps.volume_30d_bch is present in catalog', () => {
  const m = lookupKnobByKey('scoring.linear_caps.volume_30d_bch');
  assert.ok(m, 'scoring.linear_caps.volume_30d_bch must be in catalog');
  assert.equal(m.kind, 'number');
  assert.equal(m.unit, 'BCH');
  assert.equal(m.restart, true);
});

test('T46b: validateKnobValueForServer respects volume_30d_bch min/max bounds', () => {
  const meta = lookupKnobByKey('scoring.min_volume_30d_bch'); // min=0, max=10000
  assert.equal(validateKnobValueForServer(meta, -1).ok, false);
  assert.equal(validateKnobValueForServer(meta, -1).reason, 'below_min');
  assert.equal(validateKnobValueForServer(meta, 0).ok, true);
  assert.equal(validateKnobValueForServer(meta, 1.0).ok, true);
  assert.equal(validateKnobValueForServer(meta, 10000).ok, true);
  assert.equal(validateKnobValueForServer(meta, 10001).ok, false);
  assert.equal(validateKnobValueForServer(meta, 10001).reason, 'above_max');
});

test('T46b: volume_30d_bch weight key is unique in KNOBS', () => {
  const keys = KNOBS.map((k) => k.key);
  const volume30Keys = keys.filter((k) => k.includes('volume_30d_bch'));
  assert.equal(volume30Keys.length, 4,
    `expected 4 volume_30d_bch entries (weight + min + cap + linear_cap), got: ${volume30Keys.join(', ')}`);
  const unique = new Set(volume30Keys);
  assert.equal(unique.size, volume30Keys.length, 'duplicate volume_30d_bch keys');
});

// ────────────────────────────────────────────────────────────────────
//  T44 — min_trade_count_24h staleness-gate knob
//  ------------------------------------------------------------------
//  T44 introduces a new scoring knob (`scoring.min_trade_count_24h`)
//  that the operator can tune from the dashboard Settings view.
//  The catalog must enumerate it with min=0 (operator can disable)
//  and max=100000 (so a freak '1M trades/24h' input is rejected at
//  the validator layer rather than silently accepted). Pinning the
//  bounds in the test guards against a future refactor that drops
//  the catalog entry.
// ────────────────────────────────────────────────────────────────────

test('T44: scoring.min_trade_count_24h is present in catalog', () => {
  const m = lookupKnobByKey('scoring.min_trade_count_24h');
  assert.ok(m, 'scoring.min_trade_count_24h must be in catalog');
  assert.equal(m.kind, 'number');
  assert.equal(m.unit, 'trades');
  assert.equal(m.restart, true);
  assert.equal(m.group, 'scoring');
  // min=0 (operator can disable by setting 0), max=100000.
  assert.equal(m.min, 0);
  assert.equal(m.max, 100000);
});

test('T44: validateKnobValueForServer respects min_trade_count_24h min/max bounds', () => {
  const meta = lookupKnobByKey('scoring.min_trade_count_24h');
  // 0 must pass — that's the operator's "disable the gate" escape hatch.
  assert.equal(validateKnobValueForServer(meta, 0).ok, true);
  // 1 must pass — that's the small-balance default.
  assert.equal(validateKnobValueForServer(meta, 1).ok, true);
  // 100000 must pass — at the upper bound.
  assert.equal(validateKnobValueForServer(meta, 100000).ok, true);
  // negative must fail
  assert.equal(validateKnobValueForServer(meta, -1).ok, false);
  assert.equal(validateKnobValueForServer(meta, -1).reason, 'below_min');
  // over-cap must fail
  assert.equal(validateKnobValueForServer(meta, 100001).ok, false);
  assert.equal(validateKnobValueForServer(meta, 100001).reason, 'above_max');
  // NaN must fail
  assert.equal(validateKnobValueForServer(meta, NaN).ok, false);
});

test('T44: min_trade_count_24h knob key is unique in KNOBS', () => {
  const keys = KNOBS.map((k) => k.key);
  const tcKeys = keys.filter((k) => k === 'scoring.min_trade_count_24h');
  assert.equal(tcKeys.length, 1, `expected exactly 1 entry, got: ${tcKeys.join(', ')}`);
});
