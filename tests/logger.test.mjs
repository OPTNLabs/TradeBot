#!/usr/bin/env node
/**
 * Unit tests for src/util/logger.mjs.
 *
 * Pure-function tests. Uses a memory sink (no `process.stdout`)
 * so the test runner output stays clean.
 *
 * Run via:
 *   npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createLogger,
  createMemorySink,
  toJsonSafe,
  LEVELS,
} from '../src/util/logger.mjs';

// ─────────── toJsonSafe ───────────

test('toJsonSafe: primitives round-trip', () => {
  assert.equal(toJsonSafe('hello'), 'hello');
  assert.equal(toJsonSafe(42), 42);
  assert.equal(toJsonSafe(null), null);
  assert.equal(toJsonSafe(undefined), undefined);
  assert.equal(toJsonSafe(true), true);
});

test('toJsonSafe: bigint → string', () => {
  assert.equal(toJsonSafe(123n), '123');
  assert.equal(toJsonSafe(0n), '0');
});

test('toJsonSafe: Error → {name, message, stack}', () => {
  const e = new TypeError('boom');
  const out = toJsonSafe(e);
  assert.equal(out.name, 'TypeError');
  assert.equal(out.message, 'boom');
  assert.equal(typeof out.stack, 'string');
});

test('toJsonSafe: nested objects walk safely', () => {
  const obj = { a: 1, b: { c: [1, 2n, null] } };
  assert.deepEqual(toJsonSafe(obj), { a: 1, b: { c: [1, '2', null] } });
});

test('toJsonSafe: circular refs become "[Circular]"', () => {
  /** @type {any} */
  const a = { name: 'a' };
  a.self = a;
  const out = toJsonSafe(a);
  assert.equal(out.name, 'a');
  assert.equal(out.self, '[Circular]');
});

test('toJsonSafe: function → "[Function: name]"', () => {
  assert.equal(toJsonSafe(() => {}), '[Function: anonymous]');
  assert.equal(toJsonSafe(function named() {}), '[Function: named]');
});

test('toJsonSafe: symbol → its toString', () => {
  assert.equal(toJsonSafe(Symbol('x')), 'Symbol(x)');
});

// ─────────── createLogger ───────────

test('createLogger: emits a single NDJSON line to the sink', () => {
  const mem = createMemorySink();
  const log = createLogger({ sink: mem.stream, component: 't' });
  log.info('hello', { a: 1 });
  const lines = mem.lines();
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.level, 'info');
  assert.equal(rec.component, 't');
  assert.equal(rec.msg, 'hello');
  assert.equal(rec.a, 1);
  assert.match(rec.ts, /^\d{4}-\d{2}-\d{2}T/);
});

test('createLogger: ts is ISO-8601', () => {
  const mem = createMemorySink();
  const log = createLogger({ sink: mem.stream });
  log.info('x');
  const rec = JSON.parse(mem.lines()[0]);
  assert.match(rec.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('createLogger: levels below threshold are dropped', () => {
  const mem = createMemorySink();
  const log = createLogger({ sink: mem.stream, level: 'warn' });
  log.trace('no');
  log.debug('no');
  log.info('no');
  log.warn('yes');
  log.error('yes');
  log.fatal('yes');
  assert.equal(mem.lines().length, 3);
  assert.deepEqual(mem.lines().map((l) => JSON.parse(l).level), ['warn', 'error', 'fatal']);
});

test('createLogger: setLevel() changes the threshold at runtime', () => {
  const mem = createMemorySink();
  const log = createLogger({ sink: mem.stream, level: 'info' });
  log.debug('dropped');
  log.setLevel('debug');
  log.debug('kept');
  const recs = mem.lines().map((l) => JSON.parse(l).msg);
  assert.deepEqual(recs, ['kept']);
});

test('createLogger: child() inherits sink + level but overrides component', () => {
  const mem = createMemorySink();
  const root = createLogger({ sink: mem.stream, level: 'debug', component: 'root' });
  const sub = root.child('child');
  sub.debug('x');
  const rec = JSON.parse(mem.lines()[0]);
  assert.equal(rec.component, 'child');
  assert.equal(rec.level, 'debug');
  // `info` on child still drops nothing because both share level.
  sub.info('y');
  assert.equal(mem.lines().length, 2);
});

test('createLogger: per-call component overrides default', () => {
  const mem = createMemorySink();
  const log = createLogger({ sink: mem.stream, component: 'default' });
  log.info('x', { component: 'override' });
  const rec = JSON.parse(mem.lines()[0]);
  assert.equal(rec.component, 'override');
});

test('createLogger: never throws on bad input', () => {
  const mem = createMemorySink();
  const log = createLogger({ sink: mem.stream });
  // BigInt at top level → would normally throw in JSON.stringify.
  assert.doesNotThrow(() => log.info('big', { value: 1n << 200n }));
  // Circular ref in a field.
  const circ = {}; circ.self = circ;
  assert.doesNotThrow(() => log.info('circ', { c: circ }));
  // Both lines should still be written.
  assert.equal(mem.lines().length, 2);
});

test('createLogger: accepts numeric level', () => {
  const mem = createMemorySink();
  const log = createLogger({ sink: mem.stream, level: LEVELS.warn });
  log.info('dropped');
  log.warn('kept');
  assert.equal(mem.lines().length, 1);
});

test('createLogger: rejects unknown level', () => {
  assert.throws(() => createLogger({ level: 'nonsense' }), /unknown level/);
  const mem = createMemorySink();
  const log = createLogger({ sink: mem.stream });
  assert.throws(() => log.setLevel('nonsense'), /unknown level/);
});

test('createLogger: Error fields serialize as {name, message, stack}', () => {
  const mem = createMemorySink();
  const log = createLogger({ sink: mem.stream });
  log.error('boom', { err: new RangeError('bad') });
  const rec = JSON.parse(mem.lines()[0]);
  assert.equal(rec.err.name, 'RangeError');
  assert.equal(rec.err.message, 'bad');
  assert.equal(typeof rec.err.stack, 'string');
});

test('createLogger: write sink receives raw NDJSON', () => {
  const lines = [];
  const log = createLogger({ write: (l) => lines.push(l), component: 'w' });
  log.info('one');
  log.info('two');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\{"ts":/);
  assert.match(lines[0], /\n$/);
});

test('createLogger: defaults to component="app"', () => {
  const mem = createMemorySink();
  const log = createLogger({ sink: mem.stream });
  log.info('x');
  assert.equal(JSON.parse(mem.lines()[0]).component, 'app');
});

test('createLogger: msg can be a non-string and is coerced', () => {
  const mem = createMemorySink();
  const log = createLogger({ sink: mem.stream });
  log.info(42);
  assert.equal(JSON.parse(mem.lines()[0]).msg, 42);
});

// ─────────── createMemorySink ───────────

test('createMemorySink: lines() returns lines without trailing newline', () => {
  const mem = createMemorySink();
  mem.stream.write('a\n');
  mem.stream.write('b\n');
  mem.stream.write('c\n');
  assert.deepEqual(mem.lines(), ['a', 'b', 'c']);
});

test('createMemorySink: clear() empties the buffer', () => {
  const mem = createMemorySink();
  mem.stream.write('a\n');
  mem.clear();
  assert.deepEqual(mem.lines(), []);
});

// ─────────── LEVELS ordering ───────────

test('LEVELS: severity ordering is monotonic', () => {
  assert.ok(LEVELS.trace < LEVELS.debug);
  assert.ok(LEVELS.debug < LEVELS.info);
  assert.ok(LEVELS.info < LEVELS.warn);
  assert.ok(LEVELS.warn < LEVELS.error);
  assert.ok(LEVELS.error < LEVELS.fatal);
});
