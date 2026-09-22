#!/usr/bin/env node
// scripts/seed-feature-ideas.mjs
//
// One-shot (idempotent) script: loads the hand-curated seed ideas
// from `src/feature-ideas/seed.mjs` and writes any that don't
// already exist into `data/feature-ideas.json`. Re-runs are safe
// — ideas with the same `id` are skipped.
//
// Usage:
//   node scripts/seed-feature-ideas.mjs                # write any missing
//   node scripts/seed-feature-ideas.mjs --dry-run     # print, don't write
//   node scripts/seed-feature-ideas.mjs --file=...    # override file path

import process from 'node:process';

import { createLogger } from '../src/util/logger.mjs';
import { FeatureIdeasStore, validateIdea } from '../src/feature-ideas/store.mjs';
import { SEED_FEATURE_IDEAS } from '../src/feature-ideas/seed.mjs';

/**
 * @param {string[]} argv
 * @returns {{ dryRun: boolean, file: string }}
 */
function parseArgs(argv) {
  const out = { dryRun: false, file: 'data/feature-ideas.json' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--file=')) out.file = a.slice('--file='.length);
    else if (a === '--help') {
      process.stdout.write(
        'Usage: node scripts/seed-feature-ideas.mjs [--dry-run] [--file=<path>]\n',
      );
      process.exit(0);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const log = createLogger({ component: 'seed-feature-ideas', sink: process.stderr });

  // Validate every seed idea before writing. Catches typos at
  // script-time rather than at runtime.
  const validated = SEED_FEATURE_IDEAS.map((raw) => {
    const now = new Date();
    const stamped = {
      ...raw,
      status: 'pending',
      source: 'seed',
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      notes: [],
    };
    return validateIdea(stamped);
  });

  if (args.dryRun) {
    log.info('seed.dry-run', { would_insert: validated.length, file: args.file });
    process.stdout.write(JSON.stringify({ would_insert: validated.length, ideas: validated.map((i) => i.id) }, null, 2) + '\n');
    return;
  }

  const store = new FeatureIdeasStore({ file: args.file, logger: log });
  await store.load(); // initialize empty file if missing
  const result = await store.addIdeas(validated, { source: 'seed' });
  log.info('seed.complete', {
    added: result.added,
    skipped: result.skipped,
    total: result.file.meta.total_count,
  });
  process.stdout.write(JSON.stringify({
    added: result.added,
    skipped: result.skipped,
    total: result.file.meta.total_count,
    idea_ids: result.file.ideas.map((i) => i.id),
  }, null, 2) + '\n');
}

const isDirect = import.meta.url === `file://${process.argv[1]}` ||
                 process.argv[1]?.endsWith('seed-feature-ideas.mjs');
if (isDirect) {
  main().then(
    () => process.exit(0),
    (err) => {
      process.stderr.write(`seed-feature-ideas: fatal: ${err?.stack ?? err}\n`);
      process.exit(1);
    },
  );
}

export { parseArgs };
