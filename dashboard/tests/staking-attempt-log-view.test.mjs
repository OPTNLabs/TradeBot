import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attemptTone,
  attemptToneClass,
  attemptSummary,
  attemptTimestamp,
  attemptsSeverity,
  attemptsSeverityClass,
  attemptsSeverityLabel,
} from '../src/views/staking-status-helpers.mjs';

test('view: attemptTone maps phase + ok to a tone bucket', () => {
  assert.equal(attemptTone({ phase: 'success', ok: true }), 'success');
  assert.equal(attemptTone({ phase: 'failed', ok: false }), 'failed');
  assert.equal(attemptTone({ phase: 'attempt' }), 'attempt');
  assert.equal(attemptTone({}), 'info');
  assert.equal(attemptTone(null), 'info');
});

test('view: attemptToneClass returns Tailwind classes for every tone', () => {
  assert.match(attemptToneClass('success'), /emerald/);
  assert.match(attemptToneClass('failed'), /rose/);
  assert.match(attemptToneClass('attempt'), /bch/);
  assert.match(attemptToneClass('info'), /ink/);
});

test('view: attemptSummary combines kind + phase + txid + amount', () => {
  const s = attemptSummary({ kind: 'lock', phase: 'success', txid: 'a'.repeat(64), amount_sats: '50000', stake_blocks: 1440 });
  assert.match(s, /^Lock \[success\]/);
  assert.match(s, /0\.000500 BCH/);
  assert.match(s, /1440 blk/);
  assert.match(s, /txid aaaaaaaaaaaaaa/);
});

test('view: attemptSummary falls back to code + error when no txid', () => {
  const s = attemptSummary({ kind: 'lock', phase: 'failed', code: 'NO_MASTER', error: 'no masterBadger UTXO found' });
  assert.match(s, /NO_MASTER/);
  assert.match(s, /no masterBadger/);
});

test('view: attemptTimestamp renders HH:MM:SS', () => {
  const ts = attemptTimestamp({ ts: '2026-09-20T18:21:22.506Z' });
  assert.match(ts, /^\d{2}:\d{2}:\d{2}$/);
});

test('view: attemptsSeverity classifies recent activity', () => {
  assert.equal(attemptsSeverity([]), 'idle');
  assert.equal(attemptsSeverity(null), 'idle');
  assert.equal(attemptsSeverity([{ phase: 'success', ok: true }, { phase: 'success', ok: true }]), 'healthy');
  assert.equal(attemptsSeverity([{ phase: 'failed', ok: false }]), 'error');
  assert.equal(attemptsSeverity([{ phase: 'attempt' }]), 'warning');
  assert.equal(attemptsSeverity([{ phase: 'failed', ok: false }, { phase: 'failed', ok: false }, { phase: 'failed', ok: false }]), 'error');
});

test('view: attemptsSeverityClass + Label render the right copy', () => {
  assert.match(attemptsSeverityClass('healthy'), /emerald/);
  assert.match(attemptsSeverityClass('error'), /rose/);
  assert.match(attemptsSeverityClass('idle'), /ink/);
  assert.match(attemptsSeverityLabel('healthy'), /last attempt OK/);
  assert.match(attemptsSeverityLabel('error'), /FAILED/);
  assert.match(attemptsSeverityLabel('idle'), /no attempts yet/);
});
