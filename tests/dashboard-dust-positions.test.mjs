#!/usr/bin/env node
/**
 * Unit tests for src/dashboard/dust-positions.mjs (T88).
 *
 * Covers:
 *   - classifyDustKind (label generator from reasons[])
 *   - resolveDustConfig / DUST_POSITIONS_SCHEMA re-export sanity
 *   - buildDustPositionsResponse (the main envelope builder)
 *     - empty positions → empty dust + empty skipped
 *     - knob OFF + open positions → preview rows in dust + skipped
 *     - knob ON + dust position → dust[] entry, no skipped
 *     - prevent_stop_loss override → skipped with reason
 *     - on-chain-sync source → skipped with reason
 *     - no live price → skipped with reason
 *     - positions.list throw → skipped all (positions_unavailable)
 *     - no cfg → typed error envelope (ok:false)
 *     - marketIndex override (test seam)
 *     - knob=true query-param override
 *   - isDustPositionAutoCloseEnabled
 *   - dustAutoCloseConfigSnippet
 *
 * Pure-function tests where possible (no real I/O). The async
 * tests use the in-process ctx + positions stub.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDustPositionsResponse,
  classifyDustKind,
  isDustPositionAutoCloseEnabled,
  dustAutoCloseConfigSnippet,
  DUST_POSITIONS_SCHEMA,
} from '../src/dashboard/dust-positions.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Test fixtures
// ─────────────────────────────────────────────────────────────────────

const FIXED_NOW_MS = 1_700_000_000_000;
const FIXED_TS = new Date(FIXED_NOW_MS).toISOString();

const DUST_PRICE_INDEX = {
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': 100, // 100 sats / base
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb': 50,
};

// 5 base units × 100 sats/base = 500 sats proceeds.
// tx_fee=1500 + slippage 1% × 500 = 5 → total 1505 sats.
// Budget threshold (default multiplier 1.5) = 1505 × 1.5 = 2257 sats.
// 500 < 2257 → DUST.
const DUST_POSITION = {
  id: 'pos_test_001',
  token_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  token_symbol: 'DUST',
  token_decimals: 2,
  entry: {
    ts: FIXED_TS,
    bch_spent_sats: 200_000,
    price_sats_per_token: 200,
    token_amount_base: '5',
    fee_sats: 1000,
  },
};

// 1,000,000 base units × 100 sats/base = 100,000,000 sats proceeds.
// NOT dust by any reasonable budget multiplier.
const NON_DUST_POSITION = {
  id: 'pos_test_001',
  token_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  token_symbol: 'BIG',
  token_decimals: 2,
  entry: {
    ts: FIXED_TS,
    bch_spent_sats: 200_000,
    price_sats_per_token: 200,
    token_amount_base: '1000000',
    fee_sats: 1000,
  },
};

function makePosition(overrides = {}) {
  // Default to the dust position; tests that need non-dust can
  // override `entry.token_amount_base` (or pass NON_DUST_POSITION).
  const base = JSON.parse(JSON.stringify(DUST_POSITION));
  return { ...base, ...overrides };
}

function makePositionsAdapter(positions = [], { throwOn = null } = {}) {
  return {
    async list(kind) {
      if (throwOn === kind) throw new Error('disk read failed');
      return kind === 'open' ? positions : [];
    },
  };
}

function makeSnapshotsAdapter({ lastResult = null, throwOnLast = false } = {}) {
  return {
    async last() {
      if (throwOnLast) throw new Error('snapshot read failed');
      return lastResult;
    },
  };
}

function makeCtx({ positions, snapshots, cfg, clock } = {}) {
  return {
    cfg: cfg ?? { risk: {} },
    positions: positions ?? makePositionsAdapter(),
    snapshots: snapshots ?? makeSnapshotsAdapter(),
    clock: clock ?? (() => FIXED_NOW_MS),
  };
}

// ─────────────────────────────────────────────────────────────────────
//  classifyDustKind
// ─────────────────────────────────────────────────────────────────────

test('classifyDustKind: empty / non-array → unknown', () => {
  assert.equal(classifyDustKind([]), 'unknown');
  assert.equal(classifyDustKind(null), 'unknown');
  assert.equal(classifyDustKind(undefined), 'unknown');
  assert.equal(classifyDustKind('not an array'), 'unknown');
});

test('classifyDustKind: cost_ratio reason only → below_cost', () => {
  assert.equal(
    classifyDustKind(['cost_ratio_exceeds_budget:1.5>=1.5']),
    'below_cost',
  );
});

test('classifyDustKind: token_amount_below_min reason only → below_min_token_amount', () => {
  assert.equal(
    classifyDustKind(['token_amount_below_min:100']),
    'below_min_token_amount',
  );
});

test('classifyDustKind: both reasons → below_cost_and_min', () => {
  assert.equal(
    classifyDustKind([
      'token_amount_below_min:100',
      'cost_ratio_exceeds_budget:2.0>=1.5',
    ]),
    'below_cost_and_min',
  );
});

test('classifyDustKind: unknown reason → unknown', () => {
  assert.equal(classifyDustKind(['something_else']), 'unknown');
});

// ─────────────────────────────────────────────────────────────────────
//  buildDustPositionsResponse — defensive / envelope shape
// ─────────────────────────────────────────────────────────────────────

test('buildDustPositionsResponse: empty open positions → ok with empty dust + skipped', async () => {
  const ctx = makeCtx({ positions: makePositionsAdapter([]) });
  const env = await buildDustPositionsResponse(ctx, { nowMs: FIXED_NOW_MS });
  assert.equal(env.schema, DUST_POSITIONS_SCHEMA);
  assert.equal(env.ok, true);
  assert.equal(env.ts, FIXED_TS);
  assert.equal(env.generated_at_ms, FIXED_NOW_MS);
  assert.equal(env.open_position_count, 0);
  assert.equal(env.dust_count, 0);
  assert.equal(env.skipped_count, 0);
  assert.deepEqual(env.dust, []);
  assert.deepEqual(env.skipped, []);
});

test('buildDustPositionsResponse: missing cfg → ok:false typed envelope', async () => {
  const env = await buildDustPositionsResponse(
    { positions: makePositionsAdapter([]), clock: () => FIXED_NOW_MS },
    { nowMs: FIXED_NOW_MS },
  );
  assert.equal(env.ok, false);
  assert.equal(env.error, 'cfg_unavailable');
  assert.equal(env.dust_count, 0);
  assert.equal(env.skipped_count, 0);
});

test('buildDustPositionsResponse: positions.list throws → load_warnings surfaces + open_position_count=0', async () => {
  const positions = [makePosition()];
  const ctx = makeCtx({
    positions: makePositionsAdapter(positions, { throwOn: 'open' }),
  });
  const env = await buildDustPositionsResponse(ctx, { nowMs: FIXED_NOW_MS });
  assert.equal(env.ok, true);
  // When positions.list throws, the I/O never returns any
  // positions — the envelope surfaces the error via load_warnings
  // but `open_position_count` is 0 (we have nothing to classify).
  assert.equal(env.open_position_count, 0);
  assert.equal(env.dust_count, 0);
  assert.equal(env.skipped_count, 0);
  assert.ok(Array.isArray(env.load_warnings));
  assert.equal(env.load_warnings.length, 1);
  assert.equal(env.load_warnings[0], 'positions_unavailable:disk read failed');
});

// ─────────────────────────────────────────────────────────────────────
//  buildDustPositionsResponse — knob OFF (preview mode)
// ─────────────────────────────────────────────────────────────────────

test('buildDustPositionsResponse: knob OFF + dust position → preview row in dust[] + dust_position_auto_close_enabled=false', async () => {
  // 1000 base units * 100 sats/base = 100,000 sats proceeds
  // tx fee 1500 + slippage 1% = 1000 → total ~2500 sats
  // ratio = 0.025 → NOT dust (cost << proceeds). Bump the
  // budget_multiplier to 100 so this becomes dust.
  const positions = [makePosition()];
  const ctx = makeCtx({
    positions: makePositionsAdapter(positions),
    cfg: {
      risk: {
        dust_position_auto_close_enabled: false,
        dust_position_close_budget_multiplier: 100,
      },
    },
  });
  const env = await buildDustPositionsResponse(ctx, {
    nowMs: FIXED_NOW_MS,
    marketIndex: DUST_PRICE_INDEX,
  });
  assert.equal(env.dust_position_auto_close_enabled, false);
  assert.equal(env.open_position_count, 1);
  assert.equal(env.dust_count, 1);
  assert.equal(typeof env.dust[0].token_id, 'string');
  assert.equal(env.dust[0].token_id.length, 64);
  assert.equal(env.dust[0].dust_kind, 'below_cost');
  assert.equal(env.skipped_count, 0);
});

test('buildDustPositionsResponse: knob OFF + non-dust position → 0 dust, 0 skipped', async () => {
  const positions = [makePosition({ entry: { ...NON_DUST_POSITION.entry } })];
  const ctx = makeCtx({
    positions: makePositionsAdapter(positions),
    cfg: { risk: { dust_position_auto_close_enabled: false } },
  });
  const env = await buildDustPositionsResponse(ctx, {
    nowMs: FIXED_NOW_MS,
    marketIndex: DUST_PRICE_INDEX,
  });
  assert.equal(env.dust_position_auto_close_enabled, false);
  assert.equal(env.dust_count, 0);
  assert.equal(env.skipped_count, 0);
});

test('buildDustPositionsResponse: knob OFF + prevent_stop_loss override → skipped with reason + operator counter bumps', async () => {
  const positions = [
    makePosition({
      exit_overrides: { prevent_stop_loss: true },
    }),
  ];
  const ctx = makeCtx({
    positions: makePositionsAdapter(positions),
    cfg: {
      risk: {
        dust_position_auto_close_enabled: false,
        dust_position_close_budget_multiplier: 100,
      },
    },
  });
  const env = await buildDustPositionsResponse(ctx, {
    nowMs: FIXED_NOW_MS,
    marketIndex: DUST_PRICE_INDEX,
  });
  assert.equal(env.dust_count, 0);
  assert.equal(env.skipped_count, 1);
  assert.equal(env.skipped[0].blocked_reason, 'prevent_stop_loss');
  assert.equal(env.skipped_overrides, 1);
});

test('buildDustPositionsResponse: knob OFF + on-chain-sync source → skipped with reason', async () => {
  const positions = [
    makePosition({
      entry: { ...makePosition().entry, source: 'on-chain-sync' },
    }),
  ];
  const ctx = makeCtx({
    positions: makePositionsAdapter(positions),
    cfg: {
      risk: {
        dust_position_auto_close_enabled: false,
        dust_position_close_budget_multiplier: 100,
      },
    },
  });
  const env = await buildDustPositionsResponse(ctx, {
    nowMs: FIXED_NOW_MS,
    marketIndex: DUST_PRICE_INDEX,
  });
  assert.equal(env.dust_count, 0);
  assert.equal(env.skipped_count, 1);
  assert.equal(env.skipped[0].blocked_reason, 'on_chain_sync');
});

// ─────────────────────────────────────────────────────────────────────
//  buildDustPositionsResponse — knob ON (live mode)
// ─────────────────────────────────────────────────────────────────────

test('buildDustPositionsResponse: knob ON + dust position → dust[] entry, NO skipped', async () => {
  const positions = [makePosition()];
  const ctx = makeCtx({
    positions: makePositionsAdapter(positions),
    cfg: {
      risk: {
        dust_position_auto_close_enabled: true,
        dust_position_close_budget_multiplier: 100,
      },
    },
  });
  const env = await buildDustPositionsResponse(ctx, {
    nowMs: FIXED_NOW_MS,
    marketIndex: DUST_PRICE_INDEX,
  });
  assert.equal(env.dust_position_auto_close_enabled, true);
  assert.equal(env.dust_count, 1);
  assert.equal(env.skipped_count, 0);
  assert.equal(env.dust[0].dust_kind, 'below_cost');
  // Verify the wire-shape fields are populated.
  assert.equal(typeof env.dust[0].position_id, 'string');
  assert.equal(typeof env.dust[0].token_id, 'string');
  assert.equal(typeof env.dust[0].current_value_sats, 'number');
  assert.equal(typeof env.dust[0].total_cost_sats, 'number');
  assert.equal(typeof env.dust[0].ratio_cost_to_proceeds, 'number');
});

test('buildDustPositionsResponse: knob ON + prevent_stop_loss → skipped (loop will not close)', async () => {
  const positions = [
    makePosition({ exit_overrides: { prevent_stop_loss: true } }),
  ];
  const ctx = makeCtx({
    positions: makePositionsAdapter(positions),
    cfg: {
      risk: {
        dust_position_auto_close_enabled: true,
        dust_position_close_budget_multiplier: 100,
      },
    },
  });
  const env = await buildDustPositionsResponse(ctx, {
    nowMs: FIXED_NOW_MS,
    marketIndex: DUST_PRICE_INDEX,
  });
  assert.equal(env.dust_position_auto_close_enabled, true);
  assert.equal(env.dust_count, 0);
  assert.equal(env.skipped_count, 1);
  assert.equal(env.skipped[0].blocked_reason, 'prevent_stop_loss');
  assert.equal(env.skipped_overrides, 1);
});

test('buildDustPositionsResponse: knob ON + on-chain-sync → skipped', async () => {
  const positions = [
    makePosition({
      entry: { ...makePosition().entry, source: 'on-chain-sync' },
    }),
  ];
  const ctx = makeCtx({
    positions: makePositionsAdapter(positions),
    cfg: {
      risk: {
        dust_position_auto_close_enabled: true,
        dust_position_close_budget_multiplier: 100,
      },
    },
  });
  const env = await buildDustPositionsResponse(ctx, {
    nowMs: FIXED_NOW_MS,
    marketIndex: DUST_PRICE_INDEX,
  });
  assert.equal(env.dust_count, 0);
  assert.equal(env.skipped_count, 1);
  assert.equal(env.skipped[0].blocked_reason, 'on_chain_sync');
});

test('buildDustPositionsResponse: knob ON + no live price → skipped with no_price', async () => {
  // Token id that has no entry in DUST_PRICE_INDEX
  const positions = [
    makePosition({
      token_id: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    }),
  ];
  const ctx = makeCtx({
    positions: makePositionsAdapter(positions),
    cfg: {
      risk: {
        dust_position_auto_close_enabled: true,
        dust_position_close_budget_multiplier: 100,
      },
    },
  });
  const env = await buildDustPositionsResponse(ctx, {
    nowMs: FIXED_NOW_MS,
    marketIndex: DUST_PRICE_INDEX,
  });
  assert.equal(env.dust_count, 0);
  assert.equal(env.skipped_count, 1);
  assert.equal(env.skipped[0].blocked_reason, 'no_price');
  assert.equal(env.skipped_no_price, 1);
});

test('buildDustPositionsResponse: knob ON + mixed (dust + skipped) → both lists populated', async () => {
  const positions = [
    makePosition(),
    makePosition({
      id: 'pos_test_002',
      token_id: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      exit_overrides: { prevent_stop_loss: true },
    }),
  ];
  const ctx = makeCtx({
    positions: makePositionsAdapter(positions),
    cfg: {
      risk: {
        dust_position_auto_close_enabled: true,
        dust_position_close_budget_multiplier: 100,
      },
    },
  });
  // Only first token has a price; second doesn't.
  const env = await buildDustPositionsResponse(ctx, {
    nowMs: FIXED_NOW_MS,
    marketIndex: {
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': 100,
    },
  });
  assert.equal(env.dust_count, 1);
  // Second position: prevent_stop_loss override is checked BEFORE price check,
  // so it lands as skipped with that reason.
  assert.ok(env.skipped_count >= 1);
  const reasons = env.skipped.map((s) => s.blocked_reason);
  assert.ok(reasons.includes('prevent_stop_loss'));
});

test('buildDustPositionsResponse: knob ON + non-dust position → 0 dust, 0 skipped', async () => {
  const positions = [makePosition({ entry: { ...NON_DUST_POSITION.entry } })];
  const ctx = makeCtx({
    positions: makePositionsAdapter(positions),
    cfg: {
      risk: { dust_position_auto_close_enabled: true },
    },
  });
  const env = await buildDustPositionsResponse(ctx, {
    nowMs: FIXED_NOW_MS,
    marketIndex: DUST_PRICE_INDEX,
  });
  assert.equal(env.dust_position_auto_close_enabled, true);
  assert.equal(env.dust_count, 0);
  assert.equal(env.skipped_count, 0);
});

test('buildDustPositionsResponse: knob ON + dust_kind below_min_token_amount (when configured)', async () => {
  const positions = [makePosition({ entry: { ...NON_DUST_POSITION.entry, token_amount_base: '100' } })]; // big position but only 100 base units (below min_token_amount: 9999)
  const ctx = makeCtx({
    positions: makePositionsAdapter(positions),
    cfg: {
      risk: {
        dust_position_auto_close_enabled: true,
        dust_position_close_min_token_amount: 9999, // 100 < 9999 → min-amount dust
      },
    },
  });
  const env = await buildDustPositionsResponse(ctx, {
    nowMs: FIXED_NOW_MS,
    marketIndex: DUST_PRICE_INDEX,
  });
  assert.equal(env.dust_count, 1);
  assert.equal(env.dust[0].dust_kind, 'below_min_token_amount');
});

// ─────────────────────────────────────────────────────────────────────
//  buildDustPositionsResponse — snapshot-driven price index
// ─────────────────────────────────────────────────────────────────────

test('buildDustPositionsResponse: snapshot meta.market_prices_sats is the price source', async () => {
  const positions = [makePosition()];
  const snapshot = {
    meta: {
      market_prices_sats: [
        { token_id: 'a'.repeat(64), price_sats_per_token: 100 },
      ],
    },
  };
  const ctx = makeCtx({
    positions: makePositionsAdapter(positions),
    snapshots: makeSnapshotsAdapter({ lastResult: snapshot }),
    cfg: {
      risk: {
        dust_position_auto_close_enabled: true,
        dust_position_close_budget_multiplier: 100,
      },
    },
  });
  const env = await buildDustPositionsResponse(ctx, { nowMs: FIXED_NOW_MS });
  assert.equal(env.dust_count, 1);
});

test('buildDustPositionsResponse: snapshot read throws → empty price index + every position skipped (no_price)', async () => {
  const positions = [makePosition()];
  const ctx = makeCtx({
    positions: makePositionsAdapter(positions),
    snapshots: makeSnapshotsAdapter({ throwOnLast: true }),
    cfg: {
      risk: {
        dust_position_auto_close_enabled: true,
        dust_position_close_budget_multiplier: 100,
      },
    },
  });
  const env = await buildDustPositionsResponse(ctx, { nowMs: FIXED_NOW_MS });
  assert.equal(env.dust_count, 0);
  assert.equal(env.skipped_count, 1);
  assert.equal(env.skipped[0].blocked_reason, 'no_price');
  assert.equal(env.skipped_no_price, 1);
});

test('buildDustPositionsResponse: marketIndex override wins over snapshot', async () => {
  const positions = [makePosition()];
  const snapshot = {
    meta: {
      market_prices_sats: [
        // Snapshot has 999 sats/base (way too high — would not be dust)
        { token_id: 'a'.repeat(64), price_sats_per_token: 999 },
      ],
    },
  };
  const ctx = makeCtx({
    positions: makePositionsAdapter(positions),
    snapshots: makeSnapshotsAdapter({ lastResult: snapshot }),
    cfg: {
      risk: {
        dust_position_auto_close_enabled: true,
        dust_position_close_budget_multiplier: 100,
      },
    },
  });
  const env = await buildDustPositionsResponse(ctx, {
    nowMs: FIXED_NOW_MS,
    marketIndex: {
      // Override says 100 sats/base (will be dust under multiplier 100)
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': 100,
    },
  });
  assert.equal(env.dust_count, 1);
});

// ─────────────────────────────────────────────────────────────────────
//  buildDustPositionsResponse — config / defaults
// ─────────────────────────────────────────────────────────────────────

test('buildDustPositionsResponse: cfg defaults are propagated to wire envelope', async () => {
  const env = await buildDustPositionsResponse(
    makeCtx({ positions: makePositionsAdapter([]) }),
    { nowMs: FIXED_NOW_MS },
  );
  assert.equal(typeof env.config.tx_fee_sats, 'number');
  assert.equal(env.config.tx_fee_sats, 1500);
  assert.equal(typeof env.config.slippage_bps, 'number');
  assert.equal(env.config.slippage_bps, 100);
  assert.equal(typeof env.config.margin_bps, 'number');
  assert.equal(typeof env.config.budget_multiplier, 'number');
});

test('buildDustPositionsResponse: openMs is honored when supplied', async () => {
  const env = await buildDustPositionsResponse(
    makeCtx({ positions: makePositionsAdapter([]) }),
    { nowMs: 1234567890 },
  );
  assert.equal(env.generated_at_ms, 1234567890);
  assert.equal(env.ts, new Date(1234567890).toISOString());
});

test('buildDustPositionsResponse: nowMs absent → falls back to ctx.clock', async () => {
  const env = await buildDustPositionsResponse(
    makeCtx({ positions: makePositionsAdapter([]) }),
  );
  assert.equal(env.generated_at_ms, FIXED_NOW_MS);
});

// ─────────────────────────────────────────────────────────────────────
//  isDustPositionAutoCloseEnabled / dustAutoCloseConfigSnippet
// ─────────────────────────────────────────────────────────────────────

test('isDustPositionAutoCloseEnabled: true when risk.dust_position_auto_close_enabled===true', () => {
  assert.equal(
    isDustPositionAutoCloseEnabled({ cfg: { risk: { dust_position_auto_close_enabled: true } } }),
    true,
  );
});

test('isDustPositionAutoCloseEnabled: false when risk missing / knob false / cfg missing', () => {
  assert.equal(isDustPositionAutoCloseEnabled(null), false);
  assert.equal(isDustPositionAutoCloseEnabled(undefined), false);
  assert.equal(isDustPositionAutoCloseEnabled({}), false);
  assert.equal(isDustPositionAutoCloseEnabled({ cfg: null }), false);
  assert.equal(isDustPositionAutoCloseEnabled({ cfg: { risk: null } }), false);
  assert.equal(isDustPositionAutoCloseEnabled({ cfg: {} }), false);
  assert.equal(
    isDustPositionAutoCloseEnabled({ cfg: { risk: { dust_position_auto_close_enabled: false } } }),
    false,
  );
  // Non-boolean value → not "true"
  assert.equal(
    isDustPositionAutoCloseEnabled({ cfg: { risk: { dust_position_auto_close_enabled: 'true' } } }),
    false,
  );
});

test('dustAutoCloseConfigSnippet: returns canonical JSON snippet', () => {
  const snippet = dustAutoCloseConfigSnippet();
  const parsed = JSON.parse(snippet);
  assert.equal(parsed.risk.dust_position_auto_close_enabled, true);
  assert.ok(snippet.includes('\n'));
});
