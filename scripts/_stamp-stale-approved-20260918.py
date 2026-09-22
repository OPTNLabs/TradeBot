#!/usr/bin/env python3
"""
One-shot bookkeeping stamp: flip 4 stale 'approved' proposals to
'shipped' — the operator asked (Fri 2026-09-18 16:27 PDT) to
"check the approved proposals and mark them as complete if their
ask has already been shipped".

Verification done before this script ran:
  • idea_adaptive_score_weights_20260917  → T56 subset 1 (838bd67)
                                            + T56-2 trader-loop auto-wire (37ac5f9)
                                            → ASK SHIPPED, stamp 37ac5f9
  • idea_slippage_cap_per_token_20260917  → T55 per-token slippage cap (2bdb92f)
                                            → ASK SHIPPED, stamp 2bdb92f
  • idea_operator_add-badgercoin-staking_20260917
                                          → T58 subset 1 foundation + manual CLI (d62e81e)
                                            subset 2 (sign-and-broadcast + dashboard tile
                                            + unlock-cron) is the deferred follow-up
                                            tracked in TODO.md, NOT part of this idea.
                                            Stamp d62e81e + note subset-2 status.
  • idea_orphan_position_alert_20260918    → T59 subset 1 (11afc7e) + T59-2 auto-wire (887e0d4)
                                            → ASK SHIPPED, stamp 887e0d4 (final piece)

Each flip:
  - status: 'approved' → 'shipped'
  - shipped_in: null → <commit hash>
  - notes: append supervisor stamp note
  - updated_at: now()
  - meta counts advance: approved 4→3, shipped 22→26 (no change to
    pending/rejected/total).

Pure metadata edit on data/feature-ideas.json — no source files
touched, no live state touched.
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

PATH = Path('data/feature-ideas.json')

# (idea_id, commit_hash, note_body)
STAMPS = [
    (
        'idea_adaptive_score_weights_20260917',
        '37ac5f9',
        'status: approved → shipped (commit 37ac5f9; T56-2: adaptive scoring-weights trader-loop auto-wire). '
        'Two-subsets ship: T56 subset 1 (commit 838bd67) shipped the pure-function suggestion engine + '
        'manual CLI; T56-2 (commit 37ac5f9, this stamp) wired it into the trader loop so the bot tunes '
        'scoring weights every 7d from its own closed-trade history. Knob `adaptive_score_weights.enabled` '
        'is hot-read each tick.',
    ),
    (
        'idea_slippage_cap_per_token_20260917',
        '2bdb92f',
        'status: approved → shipped (commit 2bdb92f; T55: per-token slippage cap derived from AMM pool '
        'depth). `entry.slippage_cap` now scales with `candidate.amm_total_depth_sats`: deep pools → '
        '30 bps, shallow → up to 500 bps. Flat 100 bps cap is the fallback when depth data is missing '
        'or `entry.slippage_cap_per_token_enabled = false`. Reasoning blob carries `slippage_cap_source` '
        '(`flat` | `per_token`) + `slippage_cap_pool_depth_sats` so operators can audit which cap gated '
        'any decision.',
    ),
    (
        'idea_operator_add-badgercoin-staking_20260917',
        'd62e81e',
        'status: approved → shipped (commit d62e81e; T58 subset 1: BadgerCoin Staking foundation — '
        'pure-function module + manual CLI + tests). Subset 1 ships src/staking/badger-stake.mjs '
        '(commitment decoders, reward formula, lock/unlock simulation, UTXO helpers, master-state '
        'inspector, computeStakeAllocation) + scripts/stake-inspect.mjs (--inspect-master, '
        '--decode-commitment, --simulate-lock, --simulate-unlock, --simulate-allocate) + 50/50 '
        'tests + config/default.json `staking` block. Subset 2 (libauth+cashscript sign-and-broadcast '
        'lock-tx + 50%-of-inactive-BCH sizing + dashboard tile + unlock cron) is the deferred follow-up '
        'tracked in TODO.md, NOT part of this idea. When subset 2 ships the supervisor will land it as '
        'its own commit with a new note here.',
    ),
    (
        'idea_orphan_position_alert_20260918',
        '887e0d4',
        'status: approved → shipped (commit 887e0d4; T59-2: trader-loop auto-wire for orphan-position '
        'alert). Two-subsets ship: T59 subset 1 (commit 11afc7e) shipped the pure helper '
        'src/alerts/orphan-position.mjs + manual CLI scripts/check-orphan-positions.mjs + '
        'alerts.orphan_position_check_enabled knob; T59-2 (commit 887e0d4, this stamp) wired '
        'dispatchOrphanAlerts() into src/trader/loop.mjs at the END of every `_runTick()` so the bot '
        'self-monitors every tick — no separate cron needed. Routes through the existing T53 '
        'AlertRouter + NDJSON appender seams; defensive: router/appender failures are caught + '
        'logged structured so a wallet or Telegram outage can\'t kill a tick. Knob hot-reads each '
        'tick (restart:false).',
    ),
]


def main() -> int:
    if not PATH.exists():
        print(f'error: {PATH} not found', file=sys.stderr)
        return 2
    raw = json.loads(PATH.read_text())
    ideas = raw['ideas']
    meta = raw.get('meta', {})

    now = datetime.now(timezone.utc).isoformat()

    # Sanity: ensure meta exists + counter shape
    for k in ('total_count', 'pending_count', 'approved_count',
              'shipped_count', 'rejected_count'):
        if k not in meta:
            meta[k] = 0

    flipped = []
    for idea_id, commit_hash, note_body in STAMPS:
        target = next((x for x in ideas if x.get('id') == idea_id), None)
        if target is None:
            print(f'error: idea {idea_id} not found', file=sys.stderr)
            return 3
        if target.get('status') != 'approved':
            print(
                f'skip: idea {idea_id} status is {target.get("status")!r}, '
                'expected approved',
                file=sys.stderr,
            )
            continue
        if target.get('shipped_in'):
            print(
                f'skip: idea {idea_id} already has shipped_in={target.get("shipped_in")!r}',
                file=sys.stderr,
            )
            continue
        # Mutate
        target['status'] = 'shipped'
        target['shipped_in'] = commit_hash
        target['notes'] = list(target.get('notes', [])) + [{
            'ts': now,
            'author': 'operator-interactive-20260918',
            'body': note_body,
        }]
        target['updated_at'] = now
        # Update counters
        meta['approved_count'] -= 1
        meta['shipped_count'] += 1
        meta['last_modified'] = now
        meta['last_modified_by'] = 'operator-interactive-20260918'
        flipped.append(idea_id)

    if not flipped:
        print('no proposals flipped (already done?) — exiting cleanly')
        return 0

    # Pretty-print with stable formatting (matches existing 2-space + LF)
    raw['meta'] = meta
    PATH.write_text(json.dumps(raw, indent=2, ensure_ascii=False) + '\n')
    print(f'flipped {len(flipped)} proposals:')
    for fid in flipped:
        print(f'  - {fid}')
    print()
    print(f'new meta: {json.dumps(meta)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
