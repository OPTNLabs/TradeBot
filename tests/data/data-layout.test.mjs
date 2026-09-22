#!/usr/bin/env node
/**
 * tests/data/data-layout.test.mjs (DT13 structural test)
 *
 * Locks in the DATA_LAYOUT.md doc shape so a future edit cannot
 * silently drop the contract. The test is structural — it parses
 * the markdown for required sections + required schema mentions,
 * not the prose itself. No network. No filesystem writes outside
 * of `node:fs` reads.
 *
 * If you intentionally rename a section, update this test in the
 * SAME commit. The whole point is that no section can vanish
 * without a test failure first.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, '..', '..');
const DOC_PATH = join(REPO_ROOT, 'docs', 'DATA_LAYOUT.md');

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Read DATA_LAYOUT.md and return its text. Throws if missing so the
 * test fails fast with a useful message.
 *
 * @returns {string}
 */
function readDoc() {
  if (!existsSync(DOC_PATH)) {
    throw new Error(`DATA_LAYOUT.md missing at ${DOC_PATH}`);
  }
  return readFileSync(DOC_PATH, 'utf8');
}

/**
 * Extract markdown section headers (# / ## / ###) and their
 * normalised text. Used to assert required sections exist.
 *
 * @param {string} md
 * @returns {{ level: number, text: string, slug: string }[]}
 */
function extractSections(md) {
  /** @type {{ level: number, text: string, slug: string }[]} */
  const out = [];
  const re = /^(#{1,6})\s+(.+?)\s*$/gm;
  let m;
  while ((m = re.exec(md)) !== null) {
    const level = m[1].length;
    const text = m[2].trim();
    const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    out.push({ level, text, slug });
  }
  return out;
}

/**
 * Find all `# …` (level 1) or `## …` (level 2) section slugs and
 * return them as a Set. Top-level headings define the table of
 * contents; sub-headings define the contract.
 *
 * @param {string} md
 * @param {number} maxLevel
 * @returns {Set<string>}
 */
function sectionSlugsAtLevel(md, maxLevel) {
  const sections = extractSections(md);
  return new Set(
    sections.filter((s) => s.level <= maxLevel).map((s) => s.slug),
  );
}

// ─── Existence + size sanity ────────────────────────────────────────────────

describe('DATA_LAYOUT.md exists and is non-trivial', () => {
  test('docs/DATA_LAYOUT.md is present', () => {
    assert.ok(existsSync(DOC_PATH), `${DOC_PATH} must exist`);
  });

  test('docs/DATA_LAYOUT.md is > 4 KB (no trivial stub)', () => {
    const sz = statSync(DOC_PATH).size;
    assert.ok(sz > 4096, `expected > 4 KB, got ${sz} bytes`);
  });

  test('starts with `# TradeBot Data Layout` heading', () => {
    const md = readDoc();
    assert.match(md, /^#\s+TradeBot Data Layout\b/m);
  });
});

// ─── Required top-level sections (table-of-contents contract) ──────────────

describe('required top-level sections', () => {
  const REQUIRED = [
    'directory-tree',
    'file-by-file-reference',
    'snapshot-format-schema',
    'top-tokens-json-schema',
    'history-ndjson-event-schema',
    'composite-score-formula',
    'atomic-write-pattern',
    'ndjson-append-semantics',
    'token-reports',
    'how-the-trading-bot-consumes-this-data',
    'snapshot-cadence',
    'querying-historical-snapshots-code-examples',
    'backtesting-from-history-ndjson',
    're-running-pulls-on-demand',
    'key-constraints',
    'test-coverage',
    'appendix-code-surface',
  ];

  for (const slug of REQUIRED) {
    test(`section present: ${slug}`, () => {
      const md = readDoc();
      const sections = sectionSlugsAtLevel(md, 2);
      assert.ok(
        sections.has(slug),
        `DATA_LAYOUT.md is missing required section "${slug}". ` +
        `Found sections: ${[...sections].join(', ')}`,
      );
    });
  }
});

// ─── Required schema references (technical contract) ───────────────────────

describe('required technical references in the doc', () => {
  const REQUIRED_MENTIONS = [
    // Schemas
    { pattern: /RawIndexerEntry/, why: 'must reference the raw indexer entry schema' },
    { pattern: /PoolStats/, why: 'must reference the normalised PoolStats schema' },
    { pattern: /isValidPoolStats/, why: 'must point to the schema validator' },
    // Atomic write
    { pattern: /atomic[A-Za-z]*[Ww]rite/, why: 'must document the atomic-write helper' },
    { pattern: /appendFileSync|append-only|O_APPEND/, why: 'must document NDJSON append semantics' },
    // Cadence
    { pattern: /:00|every hour|hourly/, why: 'must document the :00 hourly cadence' },
    // Composite
    { pattern: /composite[_ ]?score|compositeScore/i, why: 'must document the composite-score formula' },
    // Source-of-truth modules
    { pattern: /src\/data\/fetcher\.mjs/, why: 'must reference src/data/fetcher.mjs' },
    { pattern: /src\/data\/types\.mjs/, why: 'must reference src/data/types.mjs' },
    { pattern: /scripts\/pull-data\.mjs/, why: 'must reference scripts/pull-data.mjs' },
    { pattern: /scripts\/data-tick\.mjs/, why: 'must reference scripts/data-tick.mjs' },
    // Gitignore boundary
    { pattern: /gitignore|\/data\//, why: 'must call out the /data/ gitignore boundary' },
    // Read-only guarantee
    { pattern: /read-only|never.{0,5}(sign|broadcast|touch).{0,5}wif/i,
      why: 'must state the read-only / no-WIF guarantee' },
    // Top-20 gate
    { pattern: /top-?20/i, why: 'must reference the top-20 gate' },
    // Live pool link
    { pattern: /cauldron\.quest\/token\//, why: 'must include the live pool link template' },
  ];

  for (const { pattern, why } of REQUIRED_MENTIONS) {
    test(`mentions required term: ${why}`, () => {
      const md = readDoc();
      assert.match(md, pattern, `DATA_LAYOUT.md ${why} (pattern: ${pattern})`);
    });
  }
});

// ─── Section ordering ───────────────────────────────────────────────────────

describe('section ordering', () => {
  test('directory-tree appears before file-by-file-reference', () => {
    const md = readDoc();
    const a = md.indexOf('## Directory-tree') >= 0 || md.indexOf('## Directory tree') >= 0;
    const treeIdx = md.search(/^##\s+Directory[ -]tree/m);
    const refIdx = md.search(/^##\s+File-by-file[ -]reference/m);
    assert.ok(a, 'directory-tree section must exist');
    assert.ok(treeIdx >= 0, 'directory-tree section missing');
    assert.ok(refIdx >= 0, 'file-by-file-reference section missing');
    assert.ok(treeIdx < refIdx,
      `directory-tree (${treeIdx}) must appear before file-by-file-reference (${refIdx})`);
  });

  test('how-the-trading-bot-consumes comes after token-reports', () => {
    const md = readDoc();
    const repIdx = md.search(/^##\s+Token[ -]reports/m);
    const conIdx = md.search(/^##\s+How[ -]the[ -]trading[ -]bot[ -]consumes/m);
    assert.ok(repIdx >= 0, 'token-reports section missing');
    assert.ok(conIdx >= 0, 'how-the-trading-bot-consumes section missing');
    assert.ok(repIdx < conIdx,
      'token-reports must precede the trading-bot-consumes contract');
  });
});

// ─── Code-example sanity (the doc includes runnable snippets) ──────────────

describe('code-example sanity', () => {
  test('doc contains at least 4 fenced code blocks (json/js/bash)', () => {
    const md = readDoc();
    const fences = md.match(/```/g) ?? [];
    // Each block opens + closes with ```, so the count is always even.
    assert.ok(fences.length >= 8, `expected ≥ 4 fenced blocks (≥ 8 fences), got ${fences.length / 2}`);
  });

  test('doc includes a Node.js import example referencing src/data/', () => {
    const md = readDoc();
    assert.match(md, /import\s+.*from\s+['"][^'"]*src\/data\//,
      'must show an import path under src/data/');
  });

  test('doc includes a CLI invocation example', () => {
    const md = readDoc();
    assert.match(md, /node\s+scripts\//,
      'must include at least one `node scripts/...` invocation');
  });
});

// ─── Cross-references to existing files ────────────────────────────────────

describe('cross-references to existing files in the repo', () => {
  test('every path under scripts/ referenced in the doc exists', () => {
    const md = readDoc();
    // Extract things that look like scripts/<name>.mjs references
    const scriptRefs = new Set();
    const re = /scripts\/([a-z0-9_-]+)\.mjs/g;
    let m;
    while ((m = re.exec(md)) !== null) scriptRefs.add(m[1]);

    const scriptsDir = join(REPO_ROOT, 'scripts');
    for (const name of scriptRefs) {
      const file = join(scriptsDir, `${name}.mjs`);
      assert.ok(existsSync(file),
        `doc references scripts/${name}.mjs but file does not exist at ${file}`);
    }
    assert.ok(scriptRefs.size > 0, 'expected at least one scripts/*.mjs reference');
  });

  test('every path under tests/data/ referenced in the doc exists', () => {
    const md = readDoc();
    // Match the full filename so we accept names with internal dots
    // (e.g. `snapshots.test.mjs`, `pull-data.test.mjs`).
    const testRefs = new Set();
    const re = /tests\/data\/([a-z0-9_-]+(?:\.[a-z0-9_-]+)*)\.mjs/g;
    let m;
    while ((m = re.exec(md)) !== null) testRefs.add(m[1]);

    const testsDir = join(REPO_ROOT, 'tests', 'data');
    for (const name of testRefs) {
      const file = join(testsDir, `${name}.mjs`);
      assert.ok(existsSync(file),
        `doc references tests/data/${name}.mjs but file does not exist at ${file}`);
    }
    assert.ok(testRefs.size > 0, 'expected at least one tests/data/*.mjs reference');
  });

  test('every path under src/data/ referenced in the doc exists', () => {
    const md = readDoc();
    const srcRefs = new Set();
    const re = /src\/data\/([a-z0-9_-]+)\.mjs/g;
    let m;
    while ((m = re.exec(md)) !== null) srcRefs.add(m[1]);

    const srcDir = join(REPO_ROOT, 'src', 'data');
    for (const name of srcRefs) {
      const file = join(srcDir, `${name}.mjs`);
      assert.ok(existsSync(file),
        `doc references src/data/${name}.mjs but file does not exist at ${file}`);
    }
    assert.ok(srcRefs.size > 0, 'expected at least one src/data/*.mjs reference');
  });
});