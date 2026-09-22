#!/usr/bin/env node
// dashboard/tests/staking-status-view.test.mjs
//
// T58 subset 4 — unit tests for the pure helpers exported from
// `dashboard/src/views/staking-status-helpers.mjs`. The
// component itself (`StakingStatusCard.jsx`) is a React surface;
// we exercise the stateless helpers + the knob-patch projection
// so the dashboard's most important shape contracts stay locked.
//
// Mirrors the `risk-panel-view.test.mjs` /
// `proposals-view.test.mjs` patterns.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert';

import {
  formatBch,
  satsToBch,
  lockNftCountSeverity,
  lockNftCountClass,
  autoStakeSeverity,
  autoStakeClass,
  autoStakeLabel,
  stakeAlertSeverity,
  stakeAlertClass,
  stakeAlertKindLabel,
  shortHex,
  alertAmountBch,
  buildStakingKnobPatch,
  emptyStateLabel,
  maturitySeverity,
  maturityClass,
  maturityLabel,
  maturityBarClass,
  formatBlocksToApproxDuration,
  formatPercentComplete,
  tipHeightSeverity,
  tipHeightClass,
  tipHeightLabel,
} from '../src/views/staking-status-helpers.mjs';

// ─── formatBch ────────────────────────────────────────────────────────

describe('formatBch', () => {
  it('formats finite numbers with the requested decimals', () => {
    strictEqual(formatBch(0.005), '0.005000');
    strictEqual(formatBch(0.005, 8), '0.00500000');
    strictEqual(formatBch(0), '0.000000');
  });
  it('parses numeric strings', () => {
    strictEqual(formatBch('0.01'), '0.010000');
    strictEqual(formatBch('1.5', 2), '1.50');
  });
  it('falls back to 0 for non-numeric input', () => {
    strictEqual(formatBch(null), '0.000000');
    strictEqual(formatBch(undefined), '0.000000');
    strictEqual(formatBch(NaN), '0.000000');
    strictEqual(formatBch('x'), '0.000000');
  });
});

// ─── satsToBch ────────────────────────────────────────────────────────

describe('satsToBch', () => {
  it('converts bigint satoshis', () => {
    strictEqual(satsToBch(500000n), '0.005000');
    strictEqual(satsToBch(1_000_000n), '0.010000');
  });
  it('converts numeric satoshis', () => {
    strictEqual(satsToBch(500000), '0.005000');
  });
  it('converts numeric-string satoshis', () => {
    strictEqual(satsToBch('500000'), '0.005000');
  });
  it('falls back to 0 on bad input', () => {
    strictEqual(satsToBch(null), '0.000000');
    strictEqual(satsToBch('x'), '0.000000');
    strictEqual(satsToBch({}), '0.000000');
  });
});

// ─── lockNftCountSeverity ──────────────────────────────────────────────

describe('lockNftCountSeverity', () => {
  it('returns empty / single / multiple for known counts', () => {
    strictEqual(lockNftCountSeverity(0), 'empty');
    strictEqual(lockNftCountSeverity(1), 'single');
    strictEqual(lockNftCountSeverity(2), 'multiple');
    strictEqual(lockNftCountSeverity(99), 'multiple');
  });
  it('returns unknown for null / NaN / negative / float', () => {
    strictEqual(lockNftCountSeverity(null), 'unknown');
    strictEqual(lockNftCountSeverity(undefined), 'unknown');
    strictEqual(lockNftCountSeverity(NaN), 'unknown');
    strictEqual(lockNftCountSeverity(-1), 'unknown');
    strictEqual(lockNftCountSeverity(1.5), 'unknown');
    strictEqual(lockNftCountSeverity('1'), 'unknown');
  });
});

// ─── lockNftCountClass ────────────────────────────────────────────────

describe('lockNftCountClass', () => {
  it('returns ink-styling for empty', () => {
    ok(lockNftCountClass('empty').includes('ink-700'));
  });
  it('returns bch-styling for single', () => {
    ok(lockNftCountClass('single').includes('bch-500'));
  });
  it('returns brighter bch-styling for multiple', () => {
    ok(lockNftCountClass('multiple').includes('bch-400'));
  });
  it('returns amber for unknown', () => {
    ok(lockNftCountClass('unknown').includes('amber'));
    ok(lockNftCountClass(null).includes('amber'));
  });
});

// ─── autoStakeSeverity ────────────────────────────────────────────────

describe('autoStakeSeverity', () => {
  it('returns disabled when enabled=false', () => {
    strictEqual(autoStakeSeverity({ enabled: false, simulation_only: false, auto_lock_enabled: true, auto_unlock_enabled: true }), 'disabled');
  });
  it('returns dry_run when enabled=true and simulation_only=true (regardless of submodes)', () => {
    strictEqual(autoStakeSeverity({ enabled: true, simulation_only: true, auto_lock_enabled: true, auto_unlock_enabled: true }), 'dry_run');
    strictEqual(autoStakeSeverity({ enabled: true, simulation_only: true, auto_lock_enabled: false, auto_unlock_enabled: false }), 'dry_run');
  });
  it('returns armed when enabled=true + sim=false + at least one sub-mode on', () => {
    strictEqual(autoStakeSeverity({ enabled: true, simulation_only: false, auto_lock_enabled: true, auto_unlock_enabled: false }), 'armed');
    strictEqual(autoStakeSeverity({ enabled: true, simulation_only: false, auto_lock_enabled: false, auto_unlock_enabled: true }), 'armed');
    strictEqual(autoStakeSeverity({ enabled: true, simulation_only: false, auto_lock_enabled: true, auto_unlock_enabled: true }), 'armed');
  });
  it('returns partial when enabled=true + sim=false but BOTH sub-modes off', () => {
    strictEqual(autoStakeSeverity({ enabled: true, simulation_only: false, auto_lock_enabled: false, auto_unlock_enabled: false }), 'partial');
  });
  it('returns unknown for missing / non-object knobs', () => {
    strictEqual(autoStakeSeverity(null), 'unknown');
    strictEqual(autoStakeSeverity(undefined), 'unknown');
    strictEqual(autoStakeSeverity('x'), 'unknown');
  });
});

// ─── autoStakeClass + autoStakeLabel ──────────────────────────────────

describe('autoStakeClass', () => {
  it('colors armed emerald, dry_run amber, partial ash, disabled faded', () => {
    ok(autoStakeClass('armed').includes('emerald'));
    ok(autoStakeClass('dry_run').includes('amber'));
    ok(autoStakeClass('partial').includes('ash'));
    ok(autoStakeClass('disabled').includes('ash-400'));
  });
  it('falls back to ash for unknown', () => {
    ok(autoStakeClass('unknown').includes('ash-300'));
    ok(autoStakeClass(null).includes('ash-300'));
  });
});

describe('autoStakeLabel', () => {
  it('human-friendly bucket labels', () => {
    strictEqual(autoStakeLabel('armed'), 'armed — will move BCH');
    strictEqual(autoStakeLabel('dry_run'), 'dry-run — simulation only');
    strictEqual(autoStakeLabel('partial'), 'armed, but sub-modes off');
    strictEqual(autoStakeLabel('disabled'), 'disabled');
    strictEqual(autoStakeLabel('unknown'), 'unknown');
  });
});

// ─── stakeAlertSeverity / Class / KindLabel ───────────────────────────

describe('stakeAlertSeverity', () => {
  it('info for stake_locked / stake_unlock', () => {
    strictEqual(stakeAlertSeverity('stake_locked', null), 'info');
    strictEqual(stakeAlertSeverity('stake_unlock', null), 'info');
    strictEqual(stakeAlertSeverity('stake_locked', 'info'), 'info');
  });
  it('warn for stake_failed OR severity:warn/error', () => {
    strictEqual(stakeAlertSeverity('stake_failed', null), 'warn');
    strictEqual(stakeAlertSeverity('stake_locked', 'warn'), 'warn');
    strictEqual(stakeAlertSeverity(null, 'warn'), 'warn');
    strictEqual(stakeAlertSeverity(null, 'error'), 'warn');
  });
  it('unknown when both kind and severity are absent', () => {
    strictEqual(stakeAlertSeverity(null, null), 'unknown');
    strictEqual(stakeAlertSeverity('unrelated', null), 'unknown');
  });
  it('falls back to severity when kind is missing', () => {
    // severity is the authoritative axis when kind is unknown —
    // a warn-tagged alert of any kind should render as warn.
    strictEqual(stakeAlertSeverity(null, 'info'), 'info');
  });
});

describe('stakeAlertClass', () => {
  it('bch-tint for info, amber for warn', () => {
    ok(stakeAlertClass('info').includes('bch-500'));
    ok(stakeAlertClass('warn').includes('amber'));
    ok(stakeAlertClass('unknown').includes('ink-700'));
    ok(stakeAlertClass(null).includes('ink-700'));
  });
});

describe('stakeAlertKindLabel', () => {
  it('maps kind → friendly label', () => {
    strictEqual(stakeAlertKindLabel('stake_locked'), 'lock');
    strictEqual(stakeAlertKindLabel('stake_unlock'), 'unlock');
    strictEqual(stakeAlertKindLabel('stake_failed'), 'failed');
    strictEqual(stakeAlertKindLabel(null), 'unknown');
    strictEqual(stakeAlertKindLabel('unrelated'), 'unknown');
  });
});

// ─── shortHex ─────────────────────────────────────────────────────────

describe('shortHex', () => {
  it('truncates long hex with ellipsis', () => {
    strictEqual(shortHex('abcdef0123456789abcd'), 'abcdef01…89abcd');
  });
  it('returns short hex verbatim', () => {
    strictEqual(shortHex('abc'), 'abc');
  });
  it('returns "—" for null / empty', () => {
    strictEqual(shortHex(null), '—');
    strictEqual(shortHex(undefined), '—');
    strictEqual(shortHex(''), '—');
  });
});

// ─── alertAmountBch ───────────────────────────────────────────────────

describe('alertAmountBch', () => {
  it('extracts bigint amount_sats from context', () => {
    strictEqual(alertAmountBch({ context: { amount_sats: 500000n } }), '0.005000');
  });
  it('extracts string amount_sats', () => {
    strictEqual(alertAmountBch({ context: { amount_sats: '1000000' } }), '0.010000');
  });
  it('extracts number amount_sats', () => {
    strictEqual(alertAmountBch({ context: { amount_sats: 500000 } }), '0.005000');
  });
  it('falls back to 0 on missing / non-numeric amount_sats', () => {
    strictEqual(alertAmountBch({ context: { amount_sats: null } }), '0.000000');
    strictEqual(alertAmountBch({ context: { amount_sats: 'x' } }), '0.000000');
    strictEqual(alertAmountBch({ context: {} }), '0.000000');
    strictEqual(alertAmountBch(null), '0.000000');
    strictEqual(alertAmountBch({}), '0.000000');
  });
});

// ─── buildStakingKnobPatch ─────────────────────────────────────────────

describe('buildStakingKnobPatch', () => {
  it('projects a single-knob flip', () => {
    deepStrictEqual(buildStakingKnobPatch({}, { auto_lock_enabled: true }), { staking: { auto_lock_enabled: true } });
  });
  it('merges onto the current knobs envelope', () => {
    deepStrictEqual(
      buildStakingKnobPatch({ enabled: true, simulation_only: false, auto_lock_enabled: false, auto_unlock_enabled: false }, { auto_lock_enabled: true }),
      { staking: { enabled: true, simulation_only: false, auto_lock_enabled: true, auto_unlock_enabled: false } },
    );
  });
  it('handles multi-knob changes', () => {
    deepStrictEqual(
      buildStakingKnobPatch({ enabled: false, simulation_only: true }, { enabled: true, auto_lock_enabled: true }),
      { staking: { enabled: true, simulation_only: true, auto_lock_enabled: true } },
    );
  });
  it('returns empty patch for missing / non-object changes', () => {
    deepStrictEqual(buildStakingKnobPatch({}, null), { staking: {} });
    deepStrictEqual(buildStakingKnobPatch({}, undefined), { staking: {} });
    deepStrictEqual(buildStakingKnobPatch({}, 'x'), { staking: {} });
    deepStrictEqual(buildStakingKnobPatch({}, [1, 2, 3]), { staking: {} });
  });
  it('does NOT include WIF / mnemonic / unrelated keys (deep-merge contract)', () => {
    // The patch is purely the knobs the operator flipped — the
    // backend's deepMerge onto config/user.json is responsible for
    // preserving every other key (WIF, mnemonic, etc.). The
    // helper MUST NOT bake those keys in.
    const patch = buildStakingKnobPatch({ wif: 'L1a2b3...', mnemonic: 'word list' }, { enabled: true });
    strictEqual(patch.staking.wif, undefined);
    strictEqual(patch.staking.mnemonic, undefined);
    strictEqual(patch.staking.enabled, true);
    deepStrictEqual(Object.keys(patch.staking).sort(), ['enabled']);
  });
});

// ─── emptyStateLabel ──────────────────────────────────────────────────

describe('emptyStateLabel', () => {
  it('returns wallet error verbatim when present', () => {
    strictEqual(emptyStateLabel({ wallet_configured: true, lockNfts: { error: 'electrum down', count: 0, items: [] } }), 'wallet unavailable: electrum down');
  });
  it('returns "wallet not configured" when wallet not wired', () => {
    strictEqual(emptyStateLabel({ wallet_configured: false, lockNfts: { count: 0, items: [] } }), 'wallet not configured — only knobs + alerts shown');
  });
  it('returns "no active lockNFTs" when wallet is wired but no lockNFTs', () => {
    strictEqual(emptyStateLabel({ wallet_configured: true, lockNfts: { count: 0, items: [] } }), 'no active lockNFTs in the wallet');
  });
  it('returns empty string when lockNFTs exist (no empty state needed)', () => {
    strictEqual(emptyStateLabel({ wallet_configured: true, lockNfts: { count: 1, items: [{}] } }), '');
  });
  it('returns unavailable for null status', () => {
    strictEqual(emptyStateLabel(null), 'staking state unavailable');
  });
});

// ─── T58 subset 6: maturitySeverity ─────────────────────────────────

describe('maturitySeverity', () => {
  it('returns mature / premature / never / unknown', () => {
    strictEqual(maturitySeverity('mature'), 'mature');
    strictEqual(maturitySeverity('premature'), 'premature');
    strictEqual(maturitySeverity('never'), 'never');
    strictEqual(maturitySeverity('unknown'), 'unknown');
  });
  it('returns unknown for null / unknown values', () => {
    strictEqual(maturitySeverity(null), 'unknown');
    strictEqual(maturitySeverity(undefined), 'unknown');
    strictEqual(maturitySeverity('something else'), 'unknown');
  });
});

// ─── T58 subset 6: maturityClass ──────────────────────────────────────

describe('maturityClass', () => {
  it('returns emerald styling for mature', () => {
    ok(maturityClass('mature').includes('emerald'));
  });
  it('returns ash styling for premature', () => {
    ok(maturityClass('premature').includes('ash') || maturityClass('premature').includes('ink'));
  });
  it('returns amber styling for never', () => {
    ok(maturityClass('never').includes('amber'));
  });
  it('returns ink styling for unknown', () => {
    ok(maturityClass('unknown').includes('ink'));
  });
});

// ─── T58 subset 6: maturityLabel ──────────────────────────────────────

describe('maturityLabel', () => {
  it('returns "READY NOW" for mature', () => {
    strictEqual(maturityLabel({ maturity: 'mature', blocks_remaining: 0 }), 'READY NOW');
  });
  it('returns "never (tip below lock height)" for never', () => {
    strictEqual(maturityLabel({ maturity: 'never', blocks_remaining: 1000 }), 'never (tip below lock height)');
  });
  it('returns "unknown" for unknown', () => {
    strictEqual(maturityLabel({ maturity: 'unknown', blocks_remaining: 0 }), 'unknown');
  });
  it('combines countdown with bucket for premature', () => {
    strictEqual(maturityLabel({ maturity: 'premature', blocks_remaining: 1440 }),
      'matures in ~10d (1440 blocks)');
    strictEqual(maturityLabel({ maturity: 'premature', blocks_remaining: 144 }),
      'matures in ~1d (144 blocks)');
    strictEqual(maturityLabel({ maturity: 'premature', blocks_remaining: 60 }),
      'matures in ~10h (60 blocks)');
  });
  it('returns "—" for null parts', () => {
    strictEqual(maturityLabel(null), '—');
    strictEqual(maturityLabel(undefined), '—');
    strictEqual(maturityLabel({}), 'unknown');
  });
});

// ─── T58 subset 6: maturityBarClass ────────────────────────────────────

describe('maturityBarClass', () => {
  it('returns emerald for mature', () => {
    ok(maturityBarClass('mature').includes('emerald'));
  });
  it('returns bch for premature', () => {
    ok(maturityBarClass('premature').includes('bch'));
  });
  it('returns amber for never', () => {
    ok(maturityBarClass('never').includes('amber'));
  });
  it('returns ink for unknown', () => {
    ok(maturityBarClass('unknown').includes('ink'));
  });
});

// ─── T58 subset 6: formatBlocksToApproxDuration ───────────────────────

describe('formatBlocksToApproxDuration', () => {
  it('returns "now" for 0', () => {
    strictEqual(formatBlocksToApproxDuration(0), 'now');
  });
  it('returns seconds for sub-minute ranges', () => {
    strictEqual(formatBlocksToApproxDuration(1), '~10m'); // 1 block = 600s = 10m
  });
  it('returns minutes for sub-hour ranges', () => {
    strictEqual(formatBlocksToApproxDuration(5), '~50m');
    strictEqual(formatBlocksToApproxDuration(10), '~1h 40m');
  });
  it('returns days+hours for multi-day ranges', () => {
    strictEqual(formatBlocksToApproxDuration(144), '~1d');  // 1 day
    strictEqual(formatBlocksToApproxDuration(150), '~1d 1h');
    strictEqual(formatBlocksToApproxDuration(2880), '~20d');
  });
  it('returns "—" for non-finite / negative / null input', () => {
    strictEqual(formatBlocksToApproxDuration(null), '—');
    strictEqual(formatBlocksToApproxDuration(undefined), '—');
    strictEqual(formatBlocksToApproxDuration(NaN), '—');
    strictEqual(formatBlocksToApproxDuration(-10), '—');
    strictEqual(formatBlocksToApproxDuration('x'), '—');
  });
  it('falls back to 600s/block when secondsPerBlock is bad', () => {
    // Default 600s/block — 1 block = 10m.
    strictEqual(formatBlocksToApproxDuration(1, 0), '~10m');
    strictEqual(formatBlocksToApproxDuration(1, null), '~10m');
  });
  it('honors custom secondsPerBlock', () => {
    strictEqual(formatBlocksToApproxDuration(1, 60), '~1m');
    strictEqual(formatBlocksToApproxDuration(1, 300), '~5m');
  });
});

// ─── T58 subset 6: formatPercentComplete ──────────────────────────────

describe('formatPercentComplete', () => {
  it('formats 0..1 as percentage with the requested decimals', () => {
    strictEqual(formatPercentComplete(0), '0%');
    strictEqual(formatPercentComplete(1), '100%');
    strictEqual(formatPercentComplete(0.5), '50%');
    strictEqual(formatPercentComplete(0.123, 1), '12.3%');
    strictEqual(formatPercentComplete(0.1234, 2), '12.34%');
  });
  it('clamps out-of-range fractions', () => {
    strictEqual(formatPercentComplete(-0.5), '0%');
    strictEqual(formatPercentComplete(1.5), '100%');
  });
  it('returns "—" for non-numeric input', () => {
    strictEqual(formatPercentComplete(null), '—');
    strictEqual(formatPercentComplete(undefined), '—');
    strictEqual(formatPercentComplete(NaN), '—');
    strictEqual(formatPercentComplete('x'), '—');
  });
});

// ─── T58 subset 6: tipHeightSeverity ──────────────────────────────────

describe('tipHeightSeverity', () => {
  it('returns unknown for null / missing', () => {
    strictEqual(tipHeightSeverity(null), 'unknown');
    strictEqual(tipHeightSeverity(undefined), 'unknown');
    strictEqual(tipHeightSeverity({}), 'unknown');
  });
  it('returns unavailable for unavailable source', () => {
    strictEqual(tipHeightSeverity({ tip_height_source: 'unavailable' }), 'unavailable');
    strictEqual(tipHeightSeverity({ source: 'unavailable' }), 'unavailable');
  });
  it('returns fresh for fresh source', () => {
    strictEqual(tipHeightSeverity({ tip_height_source: 'fresh' }), 'fresh');
  });
  it('returns fresh for cache source within staleMs', () => {
    strictEqual(tipHeightSeverity({ tip_height_source: 'cache', tip_height_age_ms: 5_000 }, 60_000), 'fresh');
    strictEqual(tipHeightSeverity({ source: 'cache', ageMs: 5_000 }, 60_000), 'fresh');
  });
  it('returns stale for cache source at or past staleMs', () => {
    strictEqual(tipHeightSeverity({ tip_height_source: 'cache', tip_height_age_ms: 60_000 }, 60_000), 'stale');
    strictEqual(tipHeightSeverity({ source: 'cache', ageMs: 120_000 }, 60_000), 'stale');
  });
  it('returns unknown for cache source with non-numeric age', () => {
    strictEqual(tipHeightSeverity({ tip_height_source: 'cache', tip_height_age_ms: 'x' }, 60_000), 'unknown');
  });
  it('returns unknown for unrecognized source', () => {
    strictEqual(tipHeightSeverity({ tip_height_source: 'mystery' }), 'unknown');
  });
});

// ─── T58 subset 6: tipHeightClass ─────────────────────────────────────

describe('tipHeightClass', () => {
  it('returns bch for fresh', () => {
    ok(tipHeightClass('fresh').includes('bch'));
  });
  it('returns amber for stale', () => {
    ok(tipHeightClass('stale').includes('amber'));
  });
  it('returns ink for unavailable + unknown', () => {
    ok(tipHeightClass('unavailable').includes('ink') || tipHeightClass('unavailable').includes('ash'));
    ok(tipHeightClass('unknown').includes('ink') || tipHeightClass('unknown').includes('ash'));
  });
});

// ─── T58 subset 6: tipHeightLabel ─────────────────────────────────────

describe('tipHeightLabel', () => {
  it('returns "tip: unavailable" for unavailable source', () => {
    strictEqual(tipHeightLabel({ tip_height_source: 'unavailable' }), 'tip: unavailable');
  });
  it('returns "tip: <height> · <Ns ago" for fresh', () => {
    strictEqual(tipHeightLabel({ tip_height: 826142, tip_height_source: 'fresh', tip_height_age_ms: 0 }),
      'tip: 826,142 · just now');
  });
  it('returns "tip: <height> · <Ns ago" for cache within a minute', () => {
    strictEqual(tipHeightLabel({ tip_height: 826142, tip_height_source: 'cache', tip_height_age_ms: 14_000 }),
      'tip: 826,142 · 14s ago');
  });
  it('returns "tip: <height> · <Nm ago" for cache within an hour', () => {
    strictEqual(tipHeightLabel({ tip_height: 826142, tip_height_source: 'cache', tip_height_age_ms: 5 * 60_000 }),
      'tip: 826,142 · 5m ago');
  });
  it('returns "tip: <height> · <Nh ago" for cache within a day', () => {
    strictEqual(tipHeightLabel({ tip_height: 826142, tip_height_source: 'cache', tip_height_age_ms: 3 * 3_600_000 }),
      'tip: 826,142 · 3h ago');
  });
  it('returns "tip: <height>" when age is null', () => {
    strictEqual(tipHeightLabel({ tip_height: 826142, tip_height_source: 'fresh' }),
      'tip: 826,142');
  });
  it('returns "tip: unknown" for null / missing', () => {
    strictEqual(tipHeightLabel(null), 'tip: unknown');
    strictEqual(tipHeightLabel(undefined), 'tip: unknown');
  });
});
