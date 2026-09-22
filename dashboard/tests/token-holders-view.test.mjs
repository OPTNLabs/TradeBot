#!/usr/bin/env node
// dashboard/tests/token-holders-view.test.mjs
//
// Unit tests for the T76 subset 2c dashboard view helpers. Mirrors
// the T63 / T68 / T71 dashboard test patterns: every pure helper
// gets a fixture-driven test that confirms the projected display
// row matches the expected shape. The React tile itself is
// exercised by the dashboard build (which catches import-time
// JSX errors) — these tests focus on the dependency-free
// projection layer.
//
// Coverage groups:
//   1. Numeric coercion — pctToNumber
//   2. Pct formatting — pctFormat
//   3. Severity classification — pctOfSupplySeverity, pctOfSupplySeverityClass, pctOfSupplyPillClass
//   4. Rug pattern — rugPatternSeverity, rugPatternLabel
//   5. Identity — shortAddress
//   6. BigInt → human — humanFormat
//   7. Source / cache — sourceLabel, cacheBadgeClass, cacheBadgeText
//   8. Envelope classification — isHoldersStub, isHoldersFixture, isHoldersUnavailable
//   9. Display-row builders — buildHolderRow, buildHolderHeader
//  10. Error helpers — holderErrorKey, holderErrorHint

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  pctToNumber,
  pctFormat,
  pctOfSupplySeverity,
  pctOfSupplySeverityClass,
  pctOfSupplyPillClass,
  rugPatternSeverity,
  rugPatternLabel,
  shortAddress,
  humanFormat,
  sourceLabel,
  cacheBadgeClass,
  cacheBadgeText,
  isHoldersStub,
  isHoldersFixture,
  isHoldersUnavailable,
  buildHolderRow,
  buildHolderHeader,
  holderErrorKey,
  holderErrorHint,
} from '../src/views/token-holders-helpers.mjs';

// ─────────────────────────────────────────────────────────────────────
// 1. Numeric coercion — pctToNumber
// ─────────────────────────────────────────────────────────────────────

test('token-holders-view: pctToNumber handles null / undefined / NaN / Infinity / negative / strings', () => {
  assert.equal(pctToNumber(null), null);
  assert.equal(pctToNumber(undefined), null);
  assert.equal(pctToNumber(NaN), null);
  assert.equal(pctToNumber(Infinity), null);
  assert.equal(pctToNumber(-Infinity), null);
  assert.equal(pctToNumber(-1), null, 'negative pcts are rejected (pcts are never negative)');
  assert.equal(pctToNumber(-50), null);
  assert.equal(pctToNumber(''), null);
  assert.equal(pctToNumber('  '), null);
  assert.equal(pctToNumber('abc'), null);
  assert.equal(pctToNumber({}), null);
  assert.equal(pctToNumber([]), null);
  assert.equal(pctToNumber(true), null);
});

test('token-holders-view: pctToNumber accepts finite non-negative numbers / numeric strings / bigints', () => {
  assert.equal(pctToNumber(0), 0);
  assert.equal(pctToNumber(50), 50);
  assert.equal(pctToNumber(80.5), 80.5);
  assert.equal(pctToNumber(100), 100);
  assert.equal(pctToNumber('0'), 0);
  assert.equal(pctToNumber('80'), 80);
  assert.equal(pctToNumber('80.5'), 80.5);
  assert.equal(pctToNumber('  75  '), 75, 'trims whitespace');
  assert.equal(pctToNumber(85n), 85, 'bigint coerced via toString');
  assert.equal(pctToNumber(100n), 100);
});

// ─────────────────────────────────────────────────────────────────────
// 2. Pct formatting — pctFormat
// ─────────────────────────────────────────────────────────────────────

test('token-holders-view: pctFormat returns em-dash for null / invalid / negative', () => {
  assert.equal(pctFormat(null), '—');
  assert.equal(pctFormat(undefined), '—');
  assert.equal(pctFormat(NaN), '—');
  assert.equal(pctFormat(-1), '—');
  assert.equal(pctFormat('abc'), '—');
});

test('token-holders-view: pctFormat renders 1-decimal float with % suffix', () => {
  assert.equal(pctFormat(0), '0.0%');
  assert.equal(pctFormat(50), '50.0%');
  assert.equal(pctFormat(80.5), '80.5%');
  assert.equal(pctFormat(100), '100.0%');
  assert.equal(pctFormat('75'), '75.0%');
});

// ─────────────────────────────────────────────────────────────────────
// 3. Severity classification
// ─────────────────────────────────────────────────────────────────────

test('token-holders-view: pctOfSupplySeverity bands (safe <50 / caution 50-80 / danger >=80)', () => {
  assert.equal(pctOfSupplySeverity(null), 'unknown');
  assert.equal(pctOfSupplySeverity(undefined), 'unknown');
  assert.equal(pctOfSupplySeverity(0), 'safe');
  assert.equal(pctOfSupplySeverity(49.9), 'safe');
  assert.equal(pctOfSupplySeverity(50), 'caution', 'at threshold');
  assert.equal(pctOfSupplySeverity(75), 'caution');
  assert.equal(pctOfSupplySeverity(79.9), 'caution');
  assert.equal(pctOfSupplySeverity(80), 'danger', 'at threshold');
  assert.equal(pctOfSupplySeverity(85), 'danger');
  assert.equal(pctOfSupplySeverity(100), 'danger');
});

test('token-holders-view: pctOfSupplySeverityClass maps to Tailwind colors', () => {
  assert.equal(pctOfSupplySeverityClass('safe'), 'text-emerald-400');
  assert.equal(pctOfSupplySeverityClass('caution'), 'text-amber-400');
  assert.equal(pctOfSupplySeverityClass('danger'), 'text-rose-400');
  assert.equal(pctOfSupplySeverityClass('unknown'), 'text-ash-400');
});

test('token-holders-view: pctOfSupplyPillClass maps to Tailwind pill classes', () => {
  assert.match(pctOfSupplyPillClass('safe'), /emerald/);
  assert.match(pctOfSupplyPillClass('caution'), /amber/);
  assert.match(pctOfSupplyPillClass('danger'), /rose/);
  assert.match(pctOfSupplyPillClass('unknown'), /ash/);
});

// ─────────────────────────────────────────────────────────────────────
// 4. Rug pattern
// ─────────────────────────────────────────────────────────────────────

test('token-holders-view: rugPatternSeverity maps true→danger, false→safe, null→unknown', () => {
  assert.equal(rugPatternSeverity(true), 'danger');
  assert.equal(rugPatternSeverity(false), 'safe');
  assert.equal(rugPatternSeverity(null), 'unknown');
  assert.equal(rugPatternSeverity(undefined), 'unknown');
});

test('token-holders-view: rugPatternLabel returns human-readable text', () => {
  assert.equal(rugPatternLabel(true), 'RUG PATTERN');
  assert.equal(rugPatternLabel(false), 'ok');
  assert.equal(rugPatternLabel(null), 'unknown');
});

// ─────────────────────────────────────────────────────────────────────
// 5. Identity — shortAddress
// ─────────────────────────────────────────────────────────────────────

test('token-holders-view: shortAddress truncates to keepStart + … + keepEnd', () => {
  assert.equal(shortAddress(null), '—');
  assert.equal(shortAddress(undefined), '—');
  assert.equal(shortAddress(''), '—');
  assert.equal(shortAddress('abc'), 'abc', 'shorter than window returns as-is');
  assert.equal(shortAddress('abcdefgh'), 'abcdefgh', 'at-or-under boundary');
  assert.equal(shortAddress('abcdefghi'), 'abcdefghi', '9 chars ≤ keepStart(6)+keepEnd(4)+1(…)');
  assert.equal(shortAddress('abcdefghijklmno'), 'abcdef…lmno', '15 chars > 11 → truncated');
  assert.equal(shortAddress('bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak'), 'bitcoi…57ak');
  assert.equal(shortAddress('  padded  ', 6, 4), 'padded', 'trimmed to 6 chars ≤ keepStart+keepEnd+1=11');
});

test('token-holders-view: shortAddress respects custom keepStart/keepEnd', () => {
  assert.equal(shortAddress('abcdefghijklmnop', 4, 2), 'abcd…op');
  assert.equal(shortAddress('abcdefghij', 3, 3), 'abc…hij', '10 chars > keepStart(3)+keepEnd(3)+1=7');
});

// ─────────────────────────────────────────────────────────────────────
// 6. BigInt → human — humanFormat
// ─────────────────────────────────────────────────────────────────────

test('token-holders-view: humanFormat returns em-dash for invalid input', () => {
  assert.equal(humanFormat(null), '—');
  assert.equal(humanFormat(undefined), '—');
  assert.equal(humanFormat('abc'), '—');
  assert.equal(humanFormat(''), '—');
  assert.equal(humanFormat('  '), '—');
  assert.equal(humanFormat(NaN), '—');
  assert.equal(humanFormat(1.5), '—', 'non-integer floats rejected');
  assert.equal(humanFormat({}), '—');
  assert.equal(humanFormat([]), '—');
});

test('token-holders-view: humanFormat converts base units at specified decimals', () => {
  assert.equal(humanFormat(0n, 0), '0');
  assert.equal(humanFormat(100n, 0), '100');
  assert.equal(humanFormat('1000000', 6), '1', 'trailing zero trim: 1.000000 → 1');
  assert.equal(humanFormat('1500000', 6), '1.5');
  assert.equal(humanFormat('100000000', 8), '1', 'trailing zero trim');
  assert.equal(humanFormat('50000', 0), '50000');
  assert.equal(humanFormat('123456', 6), '0.123456');
  assert.equal(humanFormat('1', 8), '0.00000001');
});

test('token-holders-view: humanFormat trims trailing zeros on fractional part', () => {
  assert.equal(humanFormat('1000000', 6), '1', 'trailing zeros all trimmed when no fraction remains');
  assert.equal(humanFormat('1100000', 6), '1.1');
  assert.equal(humanFormat('1010000', 6), '1.01');
});

test('token-holders-view: humanFormat handles negative BigInts', () => {
  assert.equal(humanFormat(-100n, 0), '-100');
  assert.equal(humanFormat('-1000000', 6), '-1', 'negative with fractional trim');
});

test('token-holders-view: humanFormat falls back to decimals=0 on invalid decimals arg', () => {
  assert.equal(humanFormat('100', -1), '100');
  assert.equal(humanFormat('100', 19), '100');
  assert.equal(humanFormat('100', NaN), '100');
  assert.equal(humanFormat('100', null), '100');
  assert.equal(humanFormat('1000000', 2.5), '10000', 'floored to 2 decimals');
});

// ─────────────────────────────────────────────────────────────────────
// 7. Source / cache
// ─────────────────────────────────────────────────────────────────────

test('token-holders-view: sourceLabel maps known upstreams to display names', () => {
  assert.equal(sourceLabel('tokenstork'), 'TokenStork');
  assert.equal(sourceLabel('electrum'), 'Electrum');
  assert.equal(sourceLabel('chaingraph'), 'Chaingraph');
  assert.equal(sourceLabel('cauldron'), 'Cauldron');
  assert.equal(sourceLabel('fixture'), 'fixture');
  assert.equal(sourceLabel('unknown_upstream'), 'unknown_upstream', 'unknown names pass through');
  assert.equal(sourceLabel(null), 'unknown');
  assert.equal(sourceLabel(undefined), 'unknown');
  assert.equal(sourceLabel(''), 'unknown');
  assert.equal(sourceLabel('  '), 'unknown');
  assert.equal(sourceLabel(123), 'unknown');
});

test('token-holders-view: cacheBadgeClass maps to Tailwind colors', () => {
  assert.match(cacheBadgeClass({ cached: false }), /amber/, 'fresh fetch → amber');
  assert.match(cacheBadgeClass({ cached: true, cache_age_ms: 1000 }), /emerald/, 'cache hit → emerald');
  assert.match(cacheBadgeClass({ fixture: true }), /ash/, 'fixture → gray');
  assert.match(cacheBadgeClass(null), /ash/, 'null envelope → gray');
  assert.match(cacheBadgeClass({}), /amber/, 'empty envelope (no cached/fixture flag) → amber');
});

test('token-holders-view: cacheBadgeText formats age in s/m/h', () => {
  assert.equal(cacheBadgeText({ cached: false }), 'fresh fetch');
  assert.equal(cacheBadgeText({ cached: true, cache_age_ms: 0 }), 'cached 0ms ago');
  assert.equal(cacheBadgeText({ cached: true, cache_age_ms: 500 }), 'cached 500ms ago');
  assert.equal(cacheBadgeText({ cached: true, cache_age_ms: 47_000 }), 'cached 47s ago');
  assert.equal(cacheBadgeText({ cached: true, cache_age_ms: 60_000 }), 'cached 1m ago');
  assert.equal(cacheBadgeText({ cached: true, cache_age_ms: 600_000 }), 'cached 10m ago');
  assert.equal(cacheBadgeText({ cached: true, cache_age_ms: 3_600_000 }), 'cached 1h ago');
  assert.equal(cacheBadgeText({ fixture: true }), 'fixture');
  assert.equal(cacheBadgeText(null), '—');
  assert.equal(cacheBadgeText({}), 'fresh fetch', 'no cached/fixture flag → fresh fetch');
  assert.equal(cacheBadgeText({ cached: true, cache_age_ms: -100 }), 'cached 0ms ago', 'negative age clamped to 0');
});

// ─────────────────────────────────────────────────────────────────────
// 8. Envelope classification
// ─────────────────────────────────────────────────────────────────────

test('token-holders-view: isHoldersStub detects subset-1 stub envelope', () => {
  assert.equal(isHoldersStub({ error: 'scanner_not_implemented' }), true);
  assert.equal(isHoldersStub({ ok: false, error: 'scanner_not_implemented' }), true);
  assert.equal(isHoldersStub({ error: 'token_not_found' }), false);
  assert.equal(isHoldersStub({ ok: true }), false);
  assert.equal(isHoldersStub(null), false);
  assert.equal(isHoldersStub({}), false);
});

test('token-holders-view: isHoldersFixture detects fixture envelope', () => {
  assert.equal(isHoldersFixture({ fixture: true }), true);
  assert.equal(isHoldersFixture({ fixture: false }), false);
  assert.equal(isHoldersFixture({ ok: true }), false, 'no fixture field → false');
  assert.equal(isHoldersFixture(null), false);
  assert.equal(isHoldersFixture({}), false);
});

test('token-holders-view: isHoldersUnavailable detects any unavailable envelope', () => {
  assert.equal(isHoldersUnavailable(null), true);
  assert.equal(isHoldersUnavailable(undefined), true);
  assert.equal(isHoldersUnavailable({}), false, 'empty envelope is "no data yet" — neither available nor unavailable');
  assert.equal(isHoldersUnavailable({ ok: true }), false, 'ok:true → available');
  assert.equal(isHoldersUnavailable({ ok: false, error: 'token_not_found' }), true);
  assert.equal(isHoldersUnavailable({ ok: false, error: 'scanner_not_implemented' }), true);
  assert.equal(isHoldersUnavailable({ ok: false, error: 'scanner_cache_not_wired' }), true);
  assert.equal(isHoldersUnavailable({ ok: false }), true, 'ok:false without error string → still unavailable');
  assert.equal(isHoldersUnavailable({ error: 'fetch_failed' }), true, 'ok:undefined + error string → unavailable');
});

// ─────────────────────────────────────────────────────────────────────
// 9. Display-row builders
// ─────────────────────────────────────────────────────────────────────

test('token-holders-view: buildHolderRow projects live envelope row to display row', () => {
  const row = buildHolderRow({
    address: 'bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak',
    balance_base: '1500000',
    pct_of_supply: 75.0,
    is_top_n: true,
    nft_count: 5,
  });
  assert.equal(row.address_short, 'bitcoi…57ak');
  assert.equal(row.balance_human, '1500000');
  assert.equal(row.pct_of_supply, 75.0);
  assert.equal(row.pct_severity, 'caution');
  assert.equal(row.pct_class, 'text-amber-400');
  assert.equal(row.pct_display, '75.0%');
  assert.equal(row.is_top_n, true);
  assert.equal(row.nft_count, 5);
});

test('token-holders-view: buildHolderRow handles missing / null fields gracefully', () => {
  const row = buildHolderRow(null);
  assert.equal(row.address, '—');
  assert.equal(row.address_short, '—');
  assert.equal(row.balance_human, '—');
  assert.equal(row.pct_display, '—');
  assert.equal(row.pct_severity, 'unknown');
  assert.equal(row.is_top_n, false);
  assert.equal(row.nft_count, 0);

  const row2 = buildHolderRow({ address: 'short', pct_of_supply: null, nft_count: undefined });
  assert.equal(row2.address_short, 'short');
  assert.equal(row2.pct_display, '—');
  assert.equal(row2.pct_severity, 'unknown');
  assert.equal(row2.nft_count, 0);
});

test('token-holders-view: buildHolderRow severity color follows pct band', () => {
  assert.equal(buildHolderRow({ address: 'a', pct_of_supply: 30 }).pct_severity, 'safe');
  assert.equal(buildHolderRow({ address: 'a', pct_of_supply: 65 }).pct_severity, 'caution');
  assert.equal(buildHolderRow({ address: 'a', pct_of_supply: 85 }).pct_severity, 'danger');
});

test('token-holders-view: buildHolderHeader projects full envelope to header card', () => {
  const env = {
    ok: true,
    token_id: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    top_n: 5,
    top_n_pct: 85.0,
    is_rug_pattern: true,
    total_holders: 12,
    total_supply_human: '1000000',
    source: 'tokenstork',
    cached: true,
    cache_age_ms: 47000,
    fixture: false,
    cache_flushed: false,
  };
  const h = buildHolderHeader(env);
  assert.equal(h.token_id_short, '012345…cdef');
  assert.equal(h.top_n_pct_display, '85.0%');
  assert.equal(h.top_n_pct_severity, 'danger');
  assert.equal(h.top_n_pct_class, 'text-rose-400');
  assert.equal(h.is_rug_pattern, true);
  assert.equal(h.rug_label, 'RUG PATTERN');
  assert.equal(h.rug_severity, 'danger');
  assert.equal(h.total_holders, 12);
  assert.equal(h.total_supply_human, '1000000');
  assert.equal(h.source_label, 'TokenStork');
  assert.match(h.cache_badge_class, /emerald/, 'cached:true → emerald');
  assert.equal(h.cache_badge_text, 'cached 47s ago');
  assert.equal(h.cached, true);
  assert.equal(h.cache_age_ms, 47000);
  assert.equal(h.ok, true);
});

test('token-holders-view: buildHolderHeader empty / null envelope returns safe defaults', () => {
  const h = buildHolderHeader(null);
  assert.equal(h.token_id, null);
  assert.equal(h.top_n_pct_display, '—');
  assert.equal(h.top_n_pct_severity, 'unknown');
  assert.equal(h.rug_label, 'unknown');
  assert.equal(h.rug_severity, 'unknown');
  assert.equal(h.total_holders, null);
  assert.equal(h.source_label, '—');
  assert.equal(h.cache_badge_text, '—');
  assert.equal(h.ok, false);

  const h2 = buildHolderHeader({});
  assert.equal(h2.top_n_pct_display, '—');
  assert.equal(h2.rug_label, 'unknown');
  assert.equal(h2.source_label, 'unknown', 'empty envelope has no source → unknown');
  assert.equal(h2.cache_badge_text, 'fresh fetch', 'no cached/fixture flag → fresh fetch');
});

test('token-holders-view: buildHolderHeader non-rug pattern shows safe band', () => {
  const h = buildHolderHeader({
    ok: true,
    token_id: 'a'.repeat(64),
    top_n_pct: 30.0,
    is_rug_pattern: false,
    total_holders: 5,
    source: 'tokenstork',
    cached: false,
    cache_age_ms: 0,
  });
  assert.equal(h.rug_severity, 'safe');
  assert.equal(h.rug_label, 'ok');
  assert.equal(h.rug_class, 'text-emerald-400');
  assert.equal(h.top_n_pct_severity, 'safe');
  assert.equal(h.cache_badge_text, 'fresh fetch');
});

test('token-holders-view: buildHolderHeader fixture envelope shows fixture badge', () => {
  const h = buildHolderHeader({
    ok: true,
    token_id: 'a'.repeat(64),
    top_n_pct: 50,
    is_rug_pattern: false,
    total_holders: 2,
    source: 'fixture',
    fixture: true,
  });
  assert.equal(h.source_label, 'fixture');
  assert.match(h.cache_badge_class, /ash/);
  assert.equal(h.cache_badge_text, 'fixture');
  assert.equal(h.fixture, true);
});

// ─────────────────────────────────────────────────────────────────────
// 10. Error helpers
// ─────────────────────────────────────────────────────────────────────

test('token-holders-view: holderErrorKey returns the error field verbatim', () => {
  assert.equal(holderErrorKey({ error: 'token_not_found' }), 'token_not_found');
  assert.equal(holderErrorKey({ error: 'scanner_not_implemented' }), 'scanner_not_implemented');
  assert.equal(holderErrorKey({ error: 'fixture_parse_failed' }), 'fixture_parse_failed');
  assert.equal(holderErrorKey({ error: 'invalid_token_id' }), 'invalid_token_id');
  assert.equal(holderErrorKey({ ok: true }), 'unknown');
  assert.equal(holderErrorKey(null), 'unknown');
  assert.equal(holderErrorKey({}), 'unknown');
});

test('token-holders-view: holderErrorHint returns remediation text for known keys, null for unknown', () => {
  assert.match(holderErrorHint('scanner_not_implemented'), /concentration_rug_enabled/);
  assert.match(holderErrorHint('token_not_found'), /indexed/);
  assert.match(holderErrorHint('scanner_cache_not_wired'), /restart/);
  assert.match(holderErrorHint('scanner_failed'), /refresh=true/);
  assert.match(holderErrorHint('fetch_failed'), /refresh=true/);
  assert.match(holderErrorHint('scanner_invalid_envelope'), /refresh=true/);
  assert.match(holderErrorHint('resolver_invalid'), /refresh=true/);
  assert.match(holderErrorHint('scanner_unexpected_throw'), /refresh=true/);
  assert.match(holderErrorHint('fixture_parse_failed'), /urlencoded/);
  assert.match(holderErrorHint('invalid_token_id'), /64-char/);
  assert.equal(holderErrorHint('unknown'), null);
  assert.equal(holderErrorHint('some_unmapped_error'), null);
  assert.equal(holderErrorHint(null), null);
  assert.equal(holderErrorHint(''), null);
});
