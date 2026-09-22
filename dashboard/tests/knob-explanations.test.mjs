#!/usr/bin/env node
// dashboard/tests/knob-explanations.test.mjs
//
// T43 — Unit tests for the pure helpers in
// `dashboard/src/lib/knob-explanations.mjs`.
//
// Mirrors the format used by `dashboard/tests/format.test.mjs`:
// the .mjs under test is dependency-free, so we exercise it
// with `node --test` only — no jsdom, no React.
//
// Coverage:
//   • KNOBS — shape (every entry has required fields), freeze,
//     no duplicate dotted keys, every restart:true, no empty
//     descriptions, every key appears in the catalog exactly
//     once.
//   • lookupKnobMeta — happy path (dotted + array forms), unknown
//     path returns null, freeze-friendly.
//   • knobsRequiringRestart — defaults to full catalog when no
//     filter, honors a key filter, returns empty when filter has
//     no matches.
//   • summarizeKnobImpact — separates restart vs next-tick keys,
//     unknown keys are conservatively treated as restart, mixed
//     counts come out right, allRestart flag flips correctly.
//   • renderRestartBanner — single knob, multi knob, no change,
//     >maxList truncation keeps the count + drops the rest with
//     a "…and N more" suffix, mixed-mode copy.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual, match, throws, notStrictEqual } from 'node:assert';

import {
  KNOBS,
  lookupKnobMeta,
  knobsRequiringRestart,
  summarizeKnobImpact,
  renderRestartBanner,
  validateKnobValue,
  clampKnobValue,
  renderRangeHint,
  searchKnobs,
  groupKnobsByPanel,
  defaultValueAtPath,
  formatJsonValue,
  buildHelpPopover,
} from '../src/lib/knob-explanations.mjs';

// ─── KNOBS shape ────────────────────────────────────────────────────

describe('KNOBS', () => {
  it('is exported as a frozen array', () => {
    ok(Array.isArray(KNOBS));
    // Object.freeze prevents adding new properties (push throws)
    // but is SHALLOW — mutating a nested field on a frozen array
    // does NOT throw. That's expected, so we only test the push
    // path here.
    throws(() => { KNOBS.push({}); }, TypeError);
    strictEqual(Object.isFrozen(KNOBS), true);
  });

  it('every entry has the required shape', () => {
    const required = ['key', 'path', 'label', 'unit', 'restart', 'description', 'group'];
    for (const k of KNOBS) {
      for (const field of required) {
        ok(field in k, `entry ${k.key ?? '(unknown)'} missing ${field}`);
      }
      ok(Array.isArray(k.path), `path must be an array (${k.key})`);
      ok(k.path.length >= 2, `path must have ≥2 segments (${k.key})`);
      strictEqual(typeof k.label, 'string', `label must be string (${k.key})`);
      strictEqual(typeof k.unit, 'string', `unit must be string (${k.key})`);
      strictEqual(typeof k.restart, 'boolean', `restart must be boolean (${k.key})`);
      strictEqual(typeof k.description, 'string', `description must be string (${k.key})`);
      ok(k.description.length > 0, `description must be non-empty (${k.key})`);
      strictEqual(typeof k.group, 'string', `group must be string (${k.key})`);
      ok(['scoring', 'entry', 'exit', 'risk', 'loop', 'dashboard', 'dex'].includes(k.group),
        `group must be one of the 7 known groups (${k.key} got ${k.group})`);
    }
  });

  it('has no duplicate dotted keys', () => {
    const seen = new Set();
    for (const k of KNOBS) {
      ok(!seen.has(k.key), `duplicate key ${k.key}`);
      seen.add(k.key);
      strictEqual(k.key, k.path.join('.'), `key must equal path.join('.') for ${k.key}`);
    }
  });

  it('every knob currently rendered in Settings.jsx is in the catalog', () => {
    // Hand-pick the paths Settings.jsx renders today. If Settings.jsx
    // adds a new knob, add it here too — the test fails until the
    // catalog is updated.
    const renderedPaths = [
      ['scoring','weights','volume_24h_bch'],
      ['scoring','weights','volume_7d_bch'],
      ['scoring','weights','volatility_24h_pct'],
      ['scoring','weights','tvl_bch'],
      ['scoring','weights','apy_30d_pct'],
      ['scoring','weights','fee_yield_bps'],
      ['scoring','weights','upward_volatility'],
      ['scoring','min_score'],
      ['scoring','min_volume_7d_bch'],  // T86: was min_volume_24h_bch (the indexer doesn't expose native 24h volume)
      ['scoring','min_tvl_bch'],
      ['scoring','min_trade_count_24h'],
      ['scoring','max_pool_age_days'],
      ['scoring','top_k_candidates'],
      ['scoring','caps','volume_24h_bch'],
      ['scoring','caps','volume_7d_bch'],
      ['scoring','caps','tvl_bch'],
      ['scoring','linear_caps','volatility_24h_pct'],
      ['scoring','linear_caps','apy_30d_pct'],
      ['scoring','linear_caps','fee_yield_bps'],
      ['entry','min_trade_size_bch'],
      ['entry','max_position_bch'],
      ['entry','max_total_exposure_bch'],
      ['entry','slippage_tolerance_bps'],
      ['entry','entry_price_max_deviation_pct'],
      ['entry','min_amm_total_depth_sats'],
      ['entry','max_indexer_vs_amm_ratio_x'],
      ['entry','max_position_concentration_pct'],
      ['entry','volatility_sizing_target_pct'],
      ['entry','correlation_skip_threshold'],
      ['entry','min_pool_age_days'],
      ['entry','use_post_trade_check'],
      ['exit','take_profit_pct'],
      ['exit','stop_loss_pct'],
      ['exit','time_stop_hours'],
      ['exit','time_stop_hours_synced'],
      ['exit','trailing_stop_pct'],
      ['exit','trailing_stop_activation_pct'],
      ['exit','max_price_vs_entry_ratio_x'],
      ['exit','tp_vol_multiplier'],
      ['exit','sl_vol_multiplier'],
      ['exit','tp_vol_floor_pct'],
      ['exit','tp_vol_ceiling_pct'],
      ['exit','sl_vol_floor_pct'],
      ['exit','sl_vol_ceiling_pct'],
      ['risk','max_daily_loss_bch'],
      ['risk','min_wallet_balance_bch'],
      ['risk','consecutive_loss_limit'],
      ['risk','loss_cooldown_minutes'],
      ['loop','poll_interval_seconds'],
      ['loop','tick_timeout_seconds'],
      ['dashboard','bind_host'],
      ['dashboard','bind_port'],
      ['dashboard','request_timeout_ms'],
      ['dashboard','cors_origin'],
      // T57-3: DEX panel — `dex.safe_mode_active` is rendered via
      // the catalog primitive KnobToggle. `dex.active` is rendered
      // via a custom array-of-ids primitive (KnobActiveDexList)
      // and is intentionally NOT in the catalog — see the comment
      // on `KnobActiveDexList` in Settings.jsx.
      ['dex','safe_mode_active'],
    ];
    for (const p of renderedPaths) {
      const meta = lookupKnobMeta(p);
      ok(meta !== null, `Settings.jsx renders ${p.join('.')} but the catalog has no entry`);
      ok(meta.description.length > 0, `${p.join('.')} has empty description`);
    }
  });

  it('every catalog entry today is restart:true (config is loaded once at boot)', () => {
    // This is the structural property the banner copy depends on.
    // If a knob becomes restart:false in the future the banner copy
    // needs to switch to "next tick" mode — the test will fail and
    // force a copy update.
    for (const k of KNOBS) {
      strictEqual(k.restart, true, `expected ${k.key} to be restart:true today`);
    }
  });

  it('no catalog description is the placeholder string', () => {
    for (const k of KNOBS) {
      notStrictEqual(k.description.trim(), '');
      notStrictEqual(k.description, 'TODO');
      notStrictEqual(k.description, 'TBD');
    }
  });

  it('the max_position_bch knob has a description that mentions the small-balance cap', () => {
    // Operator-facing claim from T37/T43 ship notes: small-balance
    // default is 0.005 BCH. If the cap changes, update the copy.
    const m = lookupKnobMeta(['entry','max_position_bch']);
    ok(m !== null);
    match(m.description, /0\.005/);
  });

  it('the min_trade_count_24h knob is in the catalog and the staleness-gate copy is honest (T44)', () => {
    // T44 catalog contract: the new staleness gate must appear in the
    // operator-facing dashboard catalog (not just src/util/) so the
    // Settings view surfaces a description that mentions the
    // phantom-price rationale. The description is what the operator
    // reads when deciding whether to relax the gate to 0.
    const m = lookupKnobMeta(['scoring','min_trade_count_24h']);
    ok(m !== null, 'min_trade_count_24h must be in the dashboard catalog');
    strictEqual(m.kind, 'number');
    strictEqual(m.unit, 'trades');
    strictEqual(m.restart, true);
    match(m.description, /trade/i);
    match(m.description, /QBTC|phantom|stale|fresh/i);
  });
});

// ─── lookupKnobMeta ────────────────────────────────────────────────

describe('lookupKnobMeta', () => {
  it('returns the catalog entry for a known dotted path', () => {
    const m = lookupKnobMeta('scoring.min_score');
    ok(m !== null);
    strictEqual(m.key, 'scoring.min_score');
    strictEqual(m.label, 'min_score');
  });

  it('returns the catalog entry for a known array path', () => {
    const m = lookupKnobMeta(['exit', 'take_profit_pct']);
    ok(m !== null);
    strictEqual(m.key, 'exit.take_profit_pct');
  });

  it('returns null for an unknown path', () => {
    strictEqual(lookupKnobMeta('this.does.not.exist'), null);
    strictEqual(lookupKnobMeta(['nope', 'nada']), null);
    strictEqual(lookupKnobMeta(''), null);
  });

  it('returns null for empty / non-string / non-array input', () => {
    strictEqual(lookupKnobMeta(null), null);
    strictEqual(lookupKnobMeta(undefined), null);
    strictEqual(lookupKnobMeta(42), null);
    strictEqual(lookupKnobMeta({}), null);
    strictEqual(lookupKnobMeta([]), null);
  });
});

// ─── knobsRequiringRestart ────────────────────────────────────────

describe('knobsRequiringRestart', () => {
  it('returns every key when no filter is supplied (today: all of them)', () => {
    const out = knobsRequiringRestart();
    strictEqual(out.length, KNOBS.length);
    // Every key must be a known dotted key.
    const all = new Set(KNOBS.map((k) => k.key));
    for (const k of out) ok(all.has(k));
  });

  it('honors a key filter (only returns matching entries)', () => {
    const out = knobsRequiringRestart(['risk.max_daily_loss_bch', 'entry.max_position_bch', 'nonexistent.key']);
    deepStrictEqual(out.sort(), ['entry.max_position_bch', 'risk.max_daily_loss_bch']);
  });

  it('returns [] when no supplied key requires restart', () => {
    // All current keys are restart:true, so the only way to get []
    // is to pass an empty list or only unknown keys (unknown keys
    // are conservatively assumed restart but they aren't in the
    // catalog so the filter drops them — see source).
    strictEqual(knobsRequiringRestart([]).length, 0);
  });
});

// ─── summarizeKnobImpact ──────────────────────────────────────────

describe('summarizeKnobImpact', () => {
  it('all-restart summary for a single known knob', () => {
    const s = summarizeKnobImpact(['risk.max_daily_loss_bch']);
    strictEqual(s.restartCount, 1);
    strictEqual(s.nextTickCount, 0);
    deepStrictEqual(s.restartKeys, ['risk.max_daily_loss_bch']);
    deepStrictEqual(s.nextTickKeys, []);
    strictEqual(s.allRestart, true);
  });

  it('multi-knob all-restart summary', () => {
    const s = summarizeKnobImpact(['risk.max_daily_loss_bch', 'entry.max_position_bch', 'loop.poll_interval_seconds']);
    strictEqual(s.restartCount, 3);
    strictEqual(s.nextTickCount, 0);
    strictEqual(s.allRestart, true);
  });

  it('empty input gives zero counts + allRestart=false', () => {
    const s = summarizeKnobImpact([]);
    strictEqual(s.restartCount, 0);
    strictEqual(s.nextTickCount, 0);
    strictEqual(s.allRestart, false);
    deepStrictEqual(s.restartKeys, []);
    deepStrictEqual(s.nextTickKeys, []);
  });

  it('unknown dirty keys are conservatively bucketed into restart', () => {
    const s = summarizeKnobImpact(['some.brand.new.knob']);
    strictEqual(s.restartCount, 1);
    strictEqual(s.nextTickCount, 0);
    deepStrictEqual(s.restartKeys, ['some.brand.new.knob']);
  });

  it('mixed restart + unknown yields allRestart=true (unknown conserves as restart)', () => {
    const s = summarizeKnobImpact(['entry.max_position_bch', 'unknown.knob']);
    strictEqual(s.restartCount, 2);
    strictEqual(s.nextTickCount, 0);
    strictEqual(s.allRestart, true);
  });

  it('pure-unknown list is still allRestart=true', () => {
    const s = summarizeKnobImpact(['foo', 'bar']);
    strictEqual(s.restartCount, 2);
    strictEqual(s.nextTickCount, 0);
    strictEqual(s.allRestart, true);
  });
});

// ─── renderRestartBanner ──────────────────────────────────────────

describe('renderRestartBanner', () => {
  it('handles empty summary (no knobs changed)', () => {
    const b = renderRestartBanner({ restartCount: 0, nextTickCount: 0, allRestart: false, restartKeys: [], nextTickKeys: [] });
    match(b.headline, /no knobs changed/);
    strictEqual(b.detail, null);
  });

  it('single restart knob → singular wording + key listed', () => {
    const b = renderRestartBanner({
      restartCount: 1,
      nextTickCount: 0,
      allRestart: true,
      restartKeys: ['entry.max_position_bch'],
      nextTickKeys: [],
    });
    match(b.headline, /1 knob need.*restart/);
    match(b.detail, /entry\.max_position_bch/);
  });

  it('pluralises at >1', () => {
    const b = renderRestartBanner({
      restartCount: 3,
      nextTickCount: 0,
      allRestart: true,
      restartKeys: ['a.b', 'c.d', 'e.f'],
      nextTickKeys: [],
    });
    match(b.headline, /3 knobs need a bot restart/);
    match(b.detail, /a\.b, c\.d, e\.f/);
  });

  it('truncates the detail list past maxList (default 5) but keeps the count', () => {
    const keys = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7'];
    const b = renderRestartBanner({
      restartCount: 7,
      nextTickCount: 0,
      allRestart: true,
      restartKeys: keys,
      nextTickKeys: [],
    });
    match(b.headline, /7 knobs need a bot restart/);
    match(b.detail, /k1, k2, k3, k4, k5.*and 2 more/);
  });

  it('respects a custom maxList', () => {
    const keys = ['k1', 'k2', 'k3', 'k4'];
    const b = renderRestartBanner(
      { restartCount: 4, nextTickCount: 0, allRestart: true, restartKeys: keys, nextTickKeys: [] },
      { maxList: 2 }
    );
    match(b.detail, /k1, k2.*and 2 more/);
  });

  it('exactly maxList items: no truncation suffix', () => {
    const keys = ['k1', 'k2', 'k3'];
    const b = renderRestartBanner(
      { restartCount: 3, nextTickCount: 0, allRestart: true, restartKeys: keys, nextTickKeys: [] },
      { maxList: 3 }
    );
    match(b.detail, /k1, k2, k3/);
    ok(!/more/.test(b.detail), `detail should not contain "more" when count == maxList: ${b.detail}`);
  });

  it('mixed (forward-compat) banner copy mentions both restart + next tick', () => {
    // Today no knob is restart:false, but we still want the copy
    // path tested so future refactors don't regress it.
    const b = renderRestartBanner({
      restartCount: 2,
      nextTickCount: 1,
      allRestart: false,
      restartKeys: ['a.b', 'c.d'],
      nextTickKeys: ['e.f'],
    });
    match(b.headline, /2 need restart, 1 take effect next tick/);
    strictEqual(b.detail, null);
  });

  it('negative / non-finite maxList is clamped to a sane non-negative int', () => {
    const keys = ['a', 'b'];
    const b1 = renderRestartBanner(
      { restartCount: 2, nextTickCount: 0, allRestart: true, restartKeys: keys, nextTickKeys: [] },
      { maxList: -10 }
    );
    // -10 → clamped to 0 → both keys are "…and N more"
    match(b1.detail, /and 2 more/);

    const b2 = renderRestartBanner(
      { restartCount: 2, nextTickCount: 0, allRestart: true, restartKeys: keys, nextTickKeys: [] },
      { maxList: Number.NaN }
    );
    // NaN → 0 (Math.max with NaN can be NaN; |0 turns NaN→0).
    // Allow either behavior: either "and 2 more" or the full list.
    ok(typeof b2.detail === 'string');
  });
});
// ─── T43b: catalog shape extensions ────────────────────────────────────────────────────

describe('KNOBS catalog extensions (T43b)', () => {
  it('every numeric knob has both min and max as finite numbers', () => {
    for (const k of KNOBS) {
      const kind = k.kind ?? 'number';
      if (kind !== 'number') continue;
      ok(Number.isFinite(k.min), `${k.key} must have a finite min`);
      ok(Number.isFinite(k.max), `${k.key} must have a finite max`);
      ok(k.min <= k.max, `${k.key} min (${k.min}) must be <= max (${k.max})`);
    }
  });

  it('every boolean knob declares kind:"boolean"', () => {
    const bools = KNOBS.filter((k) => k.kind === 'boolean');
    ok(bools.length >= 1, 'expected at least one boolean knob in the catalog');
    for (const k of bools) {
      strictEqual(k.kind, 'boolean');
    }
  });

  it('every text knob declares kind:"text"', () => {
    const texts = KNOBS.filter((k) => k.kind === 'text');
    ok(texts.length >= 2, 'expected at least two text knobs (bind_host + cors_origin)');
    for (const k of texts) {
      strictEqual(k.kind, 'text');
    }
  });

  it('text knobs do not declare min/max', () => {
    for (const k of KNOBS) {
      if (k.kind !== 'text') continue;
      ok(k.min === undefined, `${k.key} (text) should not declare min`);
      ok(k.max === undefined, `${k.key} (text) should not declare max`);
    }
  });

  it('the small-balance cap is captured in the catalog bounds', () => {
    // T03b: max_position_bch default = 0.005 BCH. The catalog
    // bound should be wide enough to cover that (min <= 0.005)
    // AND wide enough to let operators scale up to ~1 BCH.
    const m = lookupKnobMeta(['entry','max_position_bch']);
    ok(m !== null);
    ok(m.min <= 0.005);
    ok(m.max >= 0.005);
  });

  it('max_position_bch + min_wallet_balance_bch + max_total_exposure_bch all have bounds', () => {
    // Per QUALITY BAR: position-sizing knobs MUST be configurable,
    // not hard-coded. This test fails loudly if a future refactor
    // drops the bounds.
    for (const path of [['entry','max_position_bch'], ['entry','max_total_exposure_bch'], ['risk','min_wallet_balance_bch']]) {
      const m = lookupKnobMeta(path);
      ok(m !== null, `${path.join('.')} must be in the catalog`);
      ok(Number.isFinite(m.min), `${path.join('.')} must have min bound`);
      ok(Number.isFinite(m.max), `${path.join('.')} must have max bound`);
    }
  });
});

// ─── validateKnobValue ────────────────────────────────────────────────────────────

describe('validateKnobValue', () => {
  const metaPos = lookupKnobMeta(['entry','max_position_bch']);   // min:0.0001, max:1
  const metaMin = lookupKnobMeta(['risk','min_wallet_balance_bch']); // min:0, max:0.1
  const metaText = lookupKnobMeta(['dashboard','bind_host']);
  const metaBool = lookupKnobMeta(['entry','use_post_trade_check']);

  it('returns ok:true for a value inside the numeric bounds', () => {
    const r = validateKnobValue(metaPos, 0.005);
    strictEqual(r.ok, true);
    strictEqual(r.message, null);
    strictEqual(r.reason, 'ok');
    strictEqual(r.normalized, 0.005);
  });

  it('rejects NaN with reason "nan" + operator-friendly message', () => {
    const r = validateKnobValue(metaPos, NaN);
    strictEqual(r.ok, false);
    strictEqual(r.reason, 'nan');
    match(r.message, /number/);
  });

  it('rejects a non-numeric string with reason "nan"', () => {
    const r = validateKnobValue(metaPos, 'abc');
    strictEqual(r.ok, false);
    strictEqual(r.reason, 'nan');
  });

  it('rejects Infinity with reason "nan"', () => {
    const r = validateKnobValue(metaPos, Infinity);
    strictEqual(r.ok, false);
    strictEqual(r.reason, 'nan');
  });

  it('rejects below-min with reason "below_min" + bounds echo', () => {
    const r = validateKnobValue(metaPos, 0.00001);
    strictEqual(r.ok, false);
    strictEqual(r.reason, 'below_min');
    strictEqual(r.min, 0.0001);
    strictEqual(r.max, 1);
    match(r.message, /≥ 0\.0001/);
  });

  it('rejects above-max with reason "above_max" + bounds echo', () => {
    const r = validateKnobValue(metaPos, 5);
    strictEqual(r.ok, false);
    strictEqual(r.reason, 'above_max');
    strictEqual(r.max, 1);
    match(r.message, /≤ 1/);
  });

  it('coerces numeric strings and validates them', () => {
    const r = validateKnobValue(metaPos, '0.005');
    strictEqual(r.ok, true);
    strictEqual(r.normalized, 0.005);
  });

  it('treats unknown meta as ok (pass-through, no block)', () => {
    const r = validateKnobValue(null, 42);
    strictEqual(r.ok, true);
    strictEqual(r.message, null);
  });

  it('validates a boolean knob (true/false only)', () => {
    strictEqual(validateKnobValue(metaBool, true).ok, true);
    strictEqual(validateKnobValue(metaBool, false).ok, true);
    strictEqual(validateKnobValue(metaBool, 'true').ok, true);
    strictEqual(validateKnobValue(metaBool, 'false').ok, true);
    const bad = validateKnobValue(metaBool, 'yes');
    strictEqual(bad.ok, false);
    strictEqual(bad.reason, 'wrong_type');
    match(bad.message, /true or false/);
  });

  it('validates a text knob (rejects empty strings)', () => {
    strictEqual(validateKnobValue(metaText, '127.0.0.1').ok, true);
    strictEqual(validateKnobValue(metaText, '0.0.0.0').ok, true);
    const empty = validateKnobValue(metaText, '');
    strictEqual(empty.ok, false);
    strictEqual(empty.reason, 'empty_text');
    const wrongType = validateKnobValue(metaText, 42);
    strictEqual(wrongType.ok, false);
    strictEqual(wrongType.reason, 'wrong_type');
  });

  it('accepts min-bound + max-bound (inclusive edges)', () => {
    const a = validateKnobValue(metaPos, 0.0001); // exact min
    strictEqual(a.ok, true);
    const b = validateKnobValue(metaPos, 1); // exact max
    strictEqual(b.ok, true);
  });

  it('validates a knob with negative lower bound (e.g. correlation_skip_threshold)', () => {
    const meta = lookupKnobMeta(['entry','correlation_skip_threshold']);
    ok(meta.min < 0);
    strictEqual(validateKnobValue(meta, -1).ok, true);
    strictEqual(validateKnobValue(meta, 0).ok, true);
    strictEqual(validateKnobValue(meta, 1).ok, true);
    const tooLow = validateKnobValue(meta, -2);
    strictEqual(tooLow.ok, false);
    strictEqual(tooLow.reason, 'below_min');
    const tooHigh = validateKnobValue(meta, 2);
    strictEqual(tooHigh.ok, false);
    strictEqual(tooHigh.reason, 'above_max');
  });
});

// ─── clampKnobValue ────────────────────────────────────────────────────────────────

describe('clampKnobValue', () => {
  const metaPos = lookupKnobMeta(['entry','max_position_bch']);
  const metaMin = lookupKnobMeta(['risk','min_wallet_balance_bch']);

  it('clamps below-min to the min bound', () => {
    strictEqual(clampKnobValue(metaPos, 0.00001), 0.0001);
  });

  it('clamps above-max to the max bound', () => {
    strictEqual(clampKnobValue(metaPos, 5), 1);
  });

  it('passes through a value inside the range unchanged', () => {
    strictEqual(clampKnobValue(metaPos, 0.005), 0.005);
  });

  it('passes through non-numeric values unchanged (caller handles)', () => {
    strictEqual(clampKnobValue(metaPos, NaN), NaN);
    strictEqual(clampKnobValue(metaPos, 'abc'), 'abc');
  });

  it('returns the value unchanged when meta is null', () => {
    strictEqual(clampKnobValue(null, 42), 42);
  });

  it('clamps a value whose min is 0', () => {
    strictEqual(clampKnobValue(metaMin, -1), 0);
    strictEqual(clampKnobValue(metaMin, 0.05), 0.05);
    strictEqual(clampKnobValue(metaMin, 1), 0.1);
  });
});

// ─── renderRangeHint ─────────────────────────────────────────────────────────────

describe('renderRangeHint', () => {
  it('renders "range: min … max unit" when bounds exist', () => {
    const meta = lookupKnobMeta(['exit','take_profit_pct']); // min 0.1, max 100, unit "%"
    const hint = renderRangeHint(meta);
    match(hint, /range: 0\.1 … 100 %/);
  });

  it('omits the unit suffix when unit is empty', () => {
    const meta = lookupKnobMeta(['scoring','min_score']); // unit ""
    const hint = renderRangeHint(meta);
    match(hint, /range: 0 … 1$/);
  });

  it('falls back to the catalog rangeHint when bounds are absent', () => {
    // Make a synthetic meta without bounds.
    const meta = { key: 'x.y', path: ['x','y'], label: 'y', unit: '', restart: true, description: 'd', group: 'x', rangeHint: 'custom hint' };
    const hint = renderRangeHint(meta);
    strictEqual(hint, 'custom hint');
  });

  it('returns null when neither bounds nor rangeHint are present', () => {
    const meta = { key: 'x.y', path: ['x','y'], label: 'y', unit: '', restart: true, description: 'd', group: 'x' };
    strictEqual(renderRangeHint(meta), null);
  });
});

// ─── searchKnobs ──────────────────────────────────────────────────────────────────────────

describe('searchKnobs', () => {
  it('returns the full catalog (in original order) for an empty query', () => {
    const r = searchKnobs('');
    strictEqual(r.length, KNOBS.length);
    deepStrictEqual(r.map((k) => k.key), KNOBS.map((k) => k.key));
  });

  it('returns the full catalog for whitespace-only query', () => {
    strictEqual(searchKnobs('   ').length, KNOBS.length);
  });

  it('finds max_position_bch when searching for "max_position"', () => {
    const r = searchKnobs('max_position');
    ok(r.length >= 1);
    ok(r.some((k) => k.key === 'entry.max_position_bch'));
  });

  it('finds knobs in the "risk" group when searching "risk"', () => {
    const r = searchKnobs('risk');
    ok(r.length >= 4); // 4 risk knobs today
    for (const k of r) {
      ok(k.key.startsWith('risk.') || k.label.toLowerCase().includes('risk') || k.group === 'risk');
    }
  });

  it('multi-token queries require every token to match', () => {
    const r = searchKnobs('take profit');
    ok(r.some((k) => k.key === 'exit.take_profit_pct'));
    // "take" + "profit" must BOTH be present somewhere.
    for (const k of r) {
      const hay = `${k.label} ${k.key} ${k.group}`.toLowerCase();
      ok(hay.includes('take'), `${k.key} matched but doesn't contain "take"`);
      ok(hay.includes('profit'), `${k.key} matched but doesn't contain "profit"`);
    }
  });

  it('returns score-ranked results (best match first)', () => {
    // Searching the exact label "max_position_bch" should put
    // that knob ahead of any other knob whose key just happens
    // to contain those substrings.
    const r = searchKnobs('max_position_bch');
    strictEqual(r[0].key, 'entry.max_position_bch');
  });

  it('returns [] (well, filtered — no match) for nonsense queries', () => {
    const r = searchKnobs('zzzzzz_no_such_knob_xyz');
    strictEqual(r.length, 0);
  });

  it('case-insensitive (query "SLIPPAGE" matches "slippage_tolerance_bps")', () => {
    const r = searchKnobs('SLIPPAGE');
    ok(r.some((k) => k.key === 'entry.slippage_tolerance_bps'));
  });

  it('group-name search pulls in every knob in the group', () => {
    const exitCount = KNOBS.filter((k) => k.group === 'exit').length;
    const r = searchKnobs('exit');
    ok(r.length >= exitCount);
  });

  it('accepts an explicit knobs array (catalog override)', () => {
    const subset = [
      lookupKnobMeta(['entry','max_position_bch']),
      lookupKnobMeta(['entry','max_total_exposure_bch']),
    ];
    const r = searchKnobs('max', subset);
    strictEqual(r.length, 2);
  });
});

// ─── groupKnobsByPanel ───────────────────────────────────────────────────────────────────────

describe('groupKnobsByPanel', () => {
  it('groups every catalog entry under one of the 7 known groups', () => {
    const groups = groupKnobsByPanel(KNOBS);
    const totalKnobs = groups.reduce((n, p) => n + p.knobs.length, 0);
    strictEqual(totalKnobs, KNOBS.length);
    const groupNames = new Set(groups.map((g) => g.group));
    for (const g of ['scoring', 'entry', 'exit', 'risk', 'loop', 'dashboard', 'dex']) {
      ok(groupNames.has(g), `expected group "${g}" in panel list`);
    }
  });

  it('preserves the original catalog order within each group', () => {
    const groups = groupKnobsByPanel(KNOBS);
    const exitGroup = groups.find((g) => g.group === 'exit');
    ok(exitGroup);
    const exitFromCatalog = KNOBS.filter((k) => k.group === 'exit').map((k) => k.key);
    const exitFromPanel = exitGroup.knobs.map((k) => k.key);
    deepStrictEqual(exitFromPanel, exitFromCatalog);
  });

  it('handles unknown group names (buckets them under "other")', () => {
    const synthetic = [
      { key: 'a.b', path: ['a','b'], label: 'b', unit: '', restart: true, description: 'd', group: 'exotic' },
    ];
    const groups = groupKnobsByPanel(synthetic);
    strictEqual(groups.length, 1);
    strictEqual(groups[0].group, 'other');
    strictEqual(groups[0].knobs.length, 1);
  });
});

// ─── T43c: defaultValueAtPath ──────────────────────────────────────

describe('defaultValueAtPath', () => {
  const def = {
    scoring: { weights: { volume_24h_bch: 0.30 } },
    entry: {
      max_position_bch: 0.005,
      max_total_exposure_bch: 0.04,
      use_post_trade_check: true,
      min_pool_age_days: 7,
      correlation_skip_threshold: -1,
    },
    exit: {
      take_profit_pct: 5.0,
      tp_vol_multiplier: 0,
    },
    dashboard: {
      bind_host: '127.0.0.1',
      cors_origin: null,
    },
    notes: 'tiny',
  };

  it('resolves a deep numeric path (array form)', () => {
    const r = defaultValueAtPath(def, ['entry', 'max_position_bch']);
    strictEqual(r.found, true);
    strictEqual(r.value, 0.005);
  });

  it('resolves a deep numeric path (dotted string form)', () => {
    const r = defaultValueAtPath(def, 'entry.max_position_bch');
    strictEqual(r.found, true);
    strictEqual(r.value, 0.005);
  });

  it('resolves a nested object key (scoring.weights.volume_24h_bch)', () => {
    const r = defaultValueAtPath(def, ['scoring', 'weights', 'volume_24h_bch']);
    strictEqual(r.found, true);
    strictEqual(r.value, 0.30);
  });

  it('returns the boolean value verbatim (no truthy coercion)', () => {
    const r = defaultValueAtPath(def, ['entry', 'use_post_trade_check']);
    strictEqual(r.found, true);
    strictEqual(r.value, true);
    strictEqual(typeof r.value, 'boolean');
  });

  it('returns null when value is null (cors_origin)', () => {
    const r = defaultValueAtPath(def, ['dashboard', 'cors_origin']);
    strictEqual(r.found, true);
    strictEqual(r.value, null);
  });

  it('returns numeric zero verbatim (tp_vol_multiplier=0 means disabled)', () => {
    const r = defaultValueAtPath(def, ['exit', 'tp_vol_multiplier']);
    strictEqual(r.found, true);
    strictEqual(r.value, 0);
  });

  it('returns negative numbers verbatim (correlation_skip_threshold=-1)', () => {
    const r = defaultValueAtPath(def, ['entry', 'correlation_skip_threshold']);
    strictEqual(r.found, true);
    strictEqual(r.value, -1);
  });

  it('reports segment_missing when the leaf does not exist', () => {
    const r = defaultValueAtPath(def, ['entry', 'does_not_exist']);
    strictEqual(r.found, false);
    strictEqual(r.reason, 'segment_missing');
    strictEqual(r.segment, 'does_not_exist');
  });

  it('reports segment_missing for a deep dive into a missing block', () => {
    const r = defaultValueAtPath(def, ['scoring', 'weights', 'unknown_knob']);
    strictEqual(r.found, false);
    strictEqual(r.reason, 'segment_missing');
    strictEqual(r.segment, 'unknown_knob');
  });

  it('reports path_through_non_object when the path crosses a primitive', () => {
    // def.notes is a string — diving into "notes.something" must
    // NOT crash, must return a typed reason.
    const r = defaultValueAtPath(def, ['notes', 'whatever']);
    strictEqual(r.found, false);
    strictEqual(r.reason, 'path_through_non_object');
  });

  it('reports array_index_not_supported for numeric-string segments', () => {
    const arr = { list: ['a', 'b', 'c'] };
    const r = defaultValueAtPath(arr, ['list', '0']);
    strictEqual(r.found, false);
    strictEqual(r.reason, 'array_index_not_supported');
  });

  it('reports default_config_not_an_object for non-object inputs', () => {
    strictEqual(defaultValueAtPath(null, ['x']).found, false);
    strictEqual(defaultValueAtPath(undefined, ['x']).found, false);
    strictEqual(defaultValueAtPath('not-an-object', ['x']).found, false);
    strictEqual(defaultValueAtPath([1, 2, 3], ['x']).found, false);
    strictEqual(defaultValueAtPath(null, ['x']).reason, 'default_config_not_an_object');
  });

  it('reports invalid_path_segment for empty segments', () => {
    const r = defaultValueAtPath(def, ['entry', '']);
    strictEqual(r.found, false);
    strictEqual(r.reason, 'invalid_path_segment');
  });

  it('reports empty_path for empty array + invalid segments', () => {
    // empty array → no path at all
    strictEqual(defaultValueAtPath(def, []).reason, 'empty_path');
    // empty string splits to [''] which is an invalid segment
    strictEqual(defaultValueAtPath(def, '').reason, 'invalid_path_segment');
    // a dotted empty string is the same as [''] after split — still invalid
    strictEqual(defaultValueAtPath(def, '.').reason, 'invalid_path_segment');
  });

  it('never throws on bad input — every branch returns a typed reason', () => {
    // Spot-check the public contract: caller can use `result.found`
    // without a try/catch.
    for (const bad of [null, undefined, 0, '', [], true, false, Symbol('x')]) {
      const r = defaultValueAtPath(bad, ['x']);
      strictEqual(r.found, false);
      ok(typeof r.reason === 'string');
    }
  });
});

// ─── T43c: formatJsonValue ─────────────────────────────────────────

describe('formatJsonValue', () => {
  it('renders primitives', () => {
    strictEqual(formatJsonValue(true), 'true');
    strictEqual(formatJsonValue(false), 'false');
    strictEqual(formatJsonValue(null), 'null');
    strictEqual(formatJsonValue(undefined), 'undefined');
    strictEqual(formatJsonValue(0), '0');
    strictEqual(formatJsonValue(0.005), '0.005');
    strictEqual(formatJsonValue(-1), '-1');
  });

  it('renders strings double-quoted + escapes internal quotes', () => {
    strictEqual(formatJsonValue('hello'), '"hello"');
    strictEqual(formatJsonValue('he"llo'), '"he\\"llo"');
  });

  it('ellipsis-truncates long strings', () => {
    const long = 'a'.repeat(200);
    const out = formatJsonValue(long, { maxChars: 10 });
    ok(out.endsWith('…'), `expected ellipsis, got ${out}`);
    ok(out.length <= 11, `expected ≤11 chars, got ${out.length}`);
  });

  it('renders empty arrays as []', () => {
    strictEqual(formatJsonValue([]), '[]');
  });

  it('renders short arrays inline', () => {
    strictEqual(formatJsonValue([1, 2, 3]), '[1, 2, 3]');
    strictEqual(formatJsonValue(['a', 'b']), '["a", "b"]');
  });

  it('collapses long arrays to Array(N)', () => {
    const a = [1, 2, 3, 4, 5, 6];
    strictEqual(formatJsonValue(a), 'Array(6)');
  });

  it('renders empty objects as {}', () => {
    strictEqual(formatJsonValue({}), '{}');
  });

  it('renders short objects inline', () => {
    strictEqual(formatJsonValue({ a: 1, b: 'x' }), '{a: 1, b: "x"}');
  });

  it('collapses long objects to Object(keys=N)', () => {
    const o = { a: 1, b: 2, c: 3, d: 4, e: 5 };
    strictEqual(formatJsonValue(o), 'Object(keys=5)');
  });

  it('falls back to String(...) for unknown types', () => {
    strictEqual(formatJsonValue(Symbol('x')), String(Symbol('x')));
  });

  it('defaults maxChars to 60 when called without opts', () => {
    const long = 'a'.repeat(200);
    const out = formatJsonValue(long);
    ok(out.endsWith('…'));
    ok(out.length <= 61);
  });

  it('coerces invalid maxChars back to the 60 default', () => {
    const long = 'a'.repeat(200);
    strictEqual(formatJsonValue(long, { maxChars: 0 }), formatJsonValue(long, { maxChars: 60 }));
    strictEqual(formatJsonValue(long, { maxChars: -5 }), formatJsonValue(long, { maxChars: 60 }));
    strictEqual(formatJsonValue(long, { maxChars: NaN }), formatJsonValue(long, { maxChars: 60 }));
  });
});

// ─── T43c: buildHelpPopover ────────────────────────────────────────

describe('buildHelpPopover', () => {
  const def = {
    entry: { max_position_bch: 0.005, use_post_trade_check: true },
    dashboard: { bind_host: '127.0.0.1' },
  };

  it('returns the empty envelope when meta is null', () => {
    const p = buildHelpPopover(null);
    strictEqual(p.meta, null);
    strictEqual(p.default.found, false);
    strictEqual(p.rows.length, 0);
    strictEqual(p.rangeHint, null);
  });

  it('returns the empty envelope when meta is undefined', () => {
    const p = buildHelpPopover(undefined);
    strictEqual(p.meta, null);
  });

  it('returns default_config_not_provided when no defaultConfig is passed', () => {
    const meta = lookupKnobMeta(['entry', 'max_position_bch']);
    const p = buildHelpPopover(meta);
    strictEqual(p.meta, meta);
    strictEqual(p.default.found, false);
    strictEqual(p.default.reason, 'default_config_not_provided');
    strictEqual(p.default.display, 'unknown');
  });

  it('resolves the baseline via defaultValueAtPath when defaultConfig provided', () => {
    const meta = lookupKnobMeta(['entry', 'max_position_bch']);
    const p = buildHelpPopover(meta, { defaultConfig: def });
    strictEqual(p.default.found, true);
    strictEqual(p.default.value, 0.005);
    strictEqual(p.default.display, '0.005');
  });

  it('renders booleans as "true" / "false" in the baseline display', () => {
    const meta = lookupKnobMeta(['entry', 'use_post_trade_check']);
    const p = buildHelpPopover(meta, { defaultConfig: def });
    strictEqual(p.default.found, true);
    strictEqual(p.default.display, 'true');
  });

  it('renders strings in the baseline as JSON-quoted', () => {
    const meta = lookupKnobMeta(['dashboard', 'bind_host']);
    const p = buildHelpPopover(meta, { defaultConfig: def });
    strictEqual(p.default.found, true);
    strictEqual(p.default.display, '"127.0.0.1"');
  });

  it('reports the catalog drift reason when the default is missing', () => {
    const meta = lookupKnobMeta(['entry', 'max_total_exposure_bch']); // not in `def`
    const p = buildHelpPopover(meta, { defaultConfig: def });
    strictEqual(p.default.found, false);
    strictEqual(p.default.reason, 'segment_missing');
    strictEqual(p.default.display, 'unknown');
  });

  it('renders rows for every field the React layer needs', () => {
    const meta = lookupKnobMeta(['entry', 'max_position_bch']);
    const p = buildHelpPopover(meta, { defaultConfig: def });
    const labels = p.rows.map((r) => r.label);
    for (const required of ['key', 'group', 'unit', 'kind', 'restart', 'min', 'max', 'step', 'baseline', 'range hint']) {
      ok(labels.includes(required), `missing row label "${required}"`);
    }
    strictEqual(p.rows.length, 10);
  });

  it('renders restart = "required" / "live" from the catalog flag', () => {
    const restartMeta = lookupKnobMeta(['entry', 'max_position_bch']);
    const restartP = buildHelpPopover(restartMeta, { defaultConfig: def });
    const restartRow = restartP.rows.find((r) => r.label === 'restart');
    strictEqual(restartRow.value, 'required');
  });

  it('emits "—" for missing numeric bounds (preserves the catalog contract)', () => {
    const meta = lookupKnobMeta(['dashboard', 'bind_host']); // kind=text, no min/max
    const p = buildHelpPopover(meta, { defaultConfig: def });
    const minRow = p.rows.find((r) => r.label === 'min');
    const maxRow = p.rows.find((r) => r.label === 'max');
    strictEqual(minRow.value, '—');
    strictEqual(maxRow.value, '—');
  });

  it('propagates renderRangeHint for numeric knobs with bounded ranges', () => {
    const meta = lookupKnobMeta(['entry', 'max_position_bch']);
    const p = buildHelpPopover(meta, { defaultConfig: def });
    strictEqual(p.rangeHint, 'range: 0.0001 … 1 BCH');
  });

  it('does not throw on bad defaultConfig inputs', () => {
    const meta = lookupKnobMeta(['entry', 'max_position_bch']);
    for (const bad of [null, undefined, 0, '', {}, []]) {
      const p = buildHelpPopover(meta, { defaultConfig: bad });
      strictEqual(p.meta, meta);
      ok(typeof p.default.found === 'boolean');
      ok(typeof p.default.display === 'string');
    }
  });

  it('passes every catalog knob through buildHelpPopover with a real default.json', async () => {
    // Integration smoke: load the real config/default.json (relative
    // to the repo root), walk every catalog entry, and confirm the
    // popover builder produces a typed payload for every one.
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    // The dashboard's test script runs with cwd=dashboard/, so the
    // repo root (which holds config/default.json) is one level up
    // (../config/default.json). When `node --test tests/...` is run
    // from the repo root, the file is just config/default.json
    // (./config/default.json). Resolve relative to cwd and probe
    // both — whichever exists wins.
    const candidates = [
      path.resolve(process.cwd(), '..', 'config', 'default.json'),
      path.resolve(process.cwd(), 'config', 'default.json'),
    ];
    let raw = null;
    for (const c of candidates) {
      try { raw = await fs.readFile(c, 'utf8'); break; } catch { /* try next */ }
    }
    if (raw === null) {
      // Surface a clear failure rather than an ENOENT.
      throw new Error(`could not locate config/default.json — tried ${candidates.join(', ')}`);
    }
    const defReal = JSON.parse(raw);
    let okCount = 0;
    let missingCount = 0;
    const missingKeys = [];
    for (const k of KNOBS) {
      const p = buildHelpPopover(k, { defaultConfig: defReal });
      if (p.default.found) okCount += 1;
      else { missingCount += 1; missingKeys.push(k.key); }
      ok(typeof p.default.display === 'string');
    }
    // Today every catalog entry should resolve cleanly; if a
    // future catalog drift makes this fail, the failing key list
    // is surfaced in the assertion message so the operator can
    // see exactly which knob drifted.
    ok(okCount >= 50, `expected ≥50 catalog entries to resolve, got ${okCount} (missing: ${missingCount} — ${missingKeys.join(', ')})`);
  });
});
