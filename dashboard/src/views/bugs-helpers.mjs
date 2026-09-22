#!/usr/bin/env node
// dashboard/src/views/bugs-helpers.mjs
//
// Pure helpers for the BUGS view. Kept separate from the
// JSX component so they're importable from `node --test`
// (Node can't parse .jsx files without a loader). Mirrors the
// `src/views/proposals-helpers.mjs` / `src/views/reasoning-helpers.mjs`
// pattern.
//
// Every helper is dependency-free and has no side effects.

// ─────────────────────────────────────────────────────────────────────
//  Constants — exported FROZEN so accidental mutation of the dropdown
//  options can't bleed between form renders.
// ─────────────────────────────────────────────────────────────────────

/**
 * Status filter dropdown options. The trailing `id: 'all'` is the
 * "no filter" sentinel — callers should treat it as
 * "don't pass `status` to the API".
 */
export const STATUS_FILTERS = Object.freeze([
  Object.freeze({ id: 'open',        label: 'OPEN'        }),
  Object.freeze({ id: 'in_progress', label: 'IN PROGRESS' }),
  Object.freeze({ id: 'shipped',     label: 'SHIPPED'     }),
  Object.freeze({ id: 'wontfix',     label: 'WONTFIX'     }),
  Object.freeze({ id: 'all',         label: 'ALL'         }),
]);

/**
 * Category dropdown options (the bug subsystem schema's seven
 * categories + `all` sentinel for the filter dropdown).
 */
export const CATEGORY_OPTIONS = Object.freeze([
  Object.freeze({ id: 'ui',          label: 'UI'          }),
  Object.freeze({ id: 'data',        label: 'DATA'        }),
  Object.freeze({ id: 'logic',       label: 'LOGIC'       }),
  Object.freeze({ id: 'performance', label: 'PERFORMANCE' }),
  Object.freeze({ id: 'config',      label: 'CONFIG'      }),
  Object.freeze({ id: 'wallet',      label: 'WALLET'      }),
  Object.freeze({ id: 'other',       label: 'OTHER'       }),
  Object.freeze({ id: 'all',         label: 'ALL'         }),
]);

/**
 * Severity dropdown options (low|medium|high|critical + `all`
 * sentinel). Note the trailing `all` element — callers wanting
 * "real" severities only should slice off the last entry
 * (`SEVERITY_OPTIONS.slice(0, -1)`).
 */
export const SEVERITY_OPTIONS = Object.freeze([
  Object.freeze({ id: 'critical', label: 'CRITICAL' }),
  Object.freeze({ id: 'high',     label: 'HIGH'     }),
  Object.freeze({ id: 'medium',   label: 'MEDIUM'   }),
  Object.freeze({ id: 'low',      label: 'LOW'      }),
  Object.freeze({ id: 'all',      label: 'ALL'      }),
]);

/**
 * Tailwind classes for the severity badge. Critical/high borrow the
 * `text-pnl-loss` family (P&L-associate with red because criticals
 * frequently correlate with realized losses), medium is neutral, low
 * is muted. Missing / unknown → medium.
 */
export const SEVERITY_CLASS = Object.freeze({
  critical: 'text-pnl-loss border-pnl-loss/60',
  high:     'text-pnl-loss/90 border-pnl-loss/40',
  medium:   'text-ash-200 border-ink-600',
  low:      'text-ash-400 border-ink-700',
});

/**
 * Tailwind classes for the status badge. OPEN/IN_PROGRESS inherit the
 * green palette (the bot's working on it); SHIPPED/WONTFIX go muted
 * ash (terminal, no action). Missing / unknown → muted-ash.
 */
export const STATUS_BADGE_CLASS = Object.freeze({
  open:        'text-bch-300 border-bch-500/50',
  in_progress: 'text-bch-200 border-bch-500/40',
  shipped:     'text-ash-400 border-ink-700',
  wontfix:     'text-ash-500 border-ink-700',
});

/**
 * Human-friendly status labels. Status IDs are snake_case but the
 * UI shows them uppercased; this map is the single source of truth
 * so the badge + accessibility text + filter chips all match.
 */
export const STATUS_LABEL = Object.freeze({
  open: 'OPEN',
  in_progress: 'IN PROGRESS',
  shipped: 'SHIPPED',
  wontfix: 'WONTFIX',
});

/**
 * One-line tooltip + a11y description for each status. Surfaced
 * beneath each card as italic helper text.
 */
export const STATUS_DESCRIPTION = Object.freeze({
  open:        'Picked by the supervisor before any approved proposal.',
  in_progress: 'Supervisor is currently working on this; next tick will check again.',
  shipped:     'Fix has landed in a commit. The operator no longer picks these up.',
  wontfix:     'Closed without a fix (intentional, archived for audit).',
});

// ─────────────────────────────────────────────────────────────────────
//  Functions
// ─────────────────────────────────────────────────────────────────────

/**
 * Tailwind classes for a bug's status badge. Falls through to
 * the muted-ash terminal-state class on unknown / null.
 *
 * Pure. Exported for tests + so the React component stays free of
 * magic class strings.
 *
 * @param {string|null|undefined} status
 * @returns {string}
 */
export function statusClass(status) {
  if (typeof status === 'string' && Object.prototype.hasOwnProperty.call(STATUS_BADGE_CLASS, status)) {
    return STATUS_BADGE_CLASS[status];
  }
  return 'text-ash-400 border-ink-700';
}

/**
 * Tailwind classes for a bug's severity badge. Falls through to
 * `medium` on unknown / null — medium is the neutral "I don't
 * know" default.
 *
 * Pure. Exported for tests.
 *
 * @param {string|null|undefined} sev
 * @returns {string}
 */
export function severityClass(sev) {
  if (typeof sev === 'string' && Object.prototype.hasOwnProperty.call(SEVERITY_CLASS, sev)) {
    return SEVERITY_CLASS[sev];
  }
  return SEVERITY_CLASS.medium;
}

/**
 * Build the initial draft object for the create-bug form.
 * Pure. Exported for tests so mutation safety can be locked.
 *
 * @returns {{
 *   title: string,
 *   description: string,
 *   category: string,
 *   severity: string,
 *   author: string,
 * }}
 */
export function blankDraft() {
  return {
    title: '',
    description: '',
    category: 'other',
    severity: 'medium',
    author: '',
  };
}

/**
 * Client-side validation for the create-bug draft. Returns an
 * ARRAY of human-readable error strings (empty array = pass).
 * The dashboard uses the array directly as the inline error
 * list. The backend re-validates with the same rules + schema
 * `validateBug` — this client-side pass is only there to surface
 * the most common mistakes without a network round-trip.
 *
 * Pure. Exported for tests.
 *
 * Note: matching the bug-subsystem schema's CATEGORY_OPTIONS
 * (the seven real categories, no `all`) and SEVERITY_OPTIONS
 * minus the trailing `all` entry. We use `Object.values` so the
 * iteration order matches the export order above.
 *
 * @param {Object|null|undefined} d
 * @returns {string[]}
 */
export function validateDraft(d) {
  const errs = [];
  if (!d || typeof d !== 'object') {
    return ['draft must be an object'];
  }
  const allowedCategories = new Set(CATEGORY_OPTIONS.map((o) => o.id).filter((id) => id !== 'all'));
  const allowedSeverities = new Set(SEVERITY_OPTIONS.map((o) => o.id).filter((id) => id !== 'all'));
  if (typeof d.title !== 'string' || d.title.trim().length < 3) errs.push('title must be at least 3 chars');
  if (typeof d.description !== 'string' || d.description.trim().length < 5) errs.push('description must be at least 5 chars');
  if (!allowedCategories.has(d.category)) errs.push('category is required');
  if (!allowedSeverities.has(d.severity)) errs.push('severity is required');
  return errs;
}

// ─────────────────────────────────────────────────────────────────────
//  Convenience: derive category options for the create form
//  (everything in CATEGORY_OPTIONS except the `all` sentinel).
// ─────────────────────────────────────────────────────────────────────

/**
 * Category options for the CREATE form's category <select>
 * (the schema's seven categories, with the `all` sentinel
 * dropped). Exported for tests + so the form doesn't have to
 * hand-write a `.filter()` on every render.
 *
 * @returns {Array<{id: string, label: string}>}
 */
export function createFormCategoryOptions() {
  return CATEGORY_OPTIONS.filter((o) => o.id !== 'all').map((o) => ({ id: o.id, label: o.label }));
}

/**
 * Severity options for the CREATE form's severity <select>
 * (schema's four severities, with the `all` sentinel dropped).
 *
 * @returns {Array<{id: string, label: string}>}
 */
export function createFormSeverityOptions() {
  return SEVERITY_OPTIONS.filter((o) => o.id !== 'all').map((o) => ({ id: o.id, label: o.label }));
}

// ─────────────────────────────────────────────────────────────────────
//  Create-bug panel subtitle (T51)
// ─────────────────────────────────────────────────────────────────────

/**
 * Subtitle text for the `NEED A NEW BUG FILED?` panel.
 *
 * When the operator has NOT supplied a bearer token via `?token=...`
 * the dashboard runs in read-only mode — the create-bug button still
 * renders (so the layout doesn't jump) but tapping it just nudges the
 * operator to add the token. We surface that as a one-line subtitle
 * hint so the operator doesn't have to guess why nothing happens when
 * they click "+ file a bug".
 *
 * Coerces non-boolean inputs to safe defaults so a future caller that
 * accidentally passes `undefined` / `null` / `''` still gets a sane
 * string back instead of throwing inside the JSX render path.
 *
 * @param {boolean} showCreate   true once the operator opened the form
 * @param {boolean} canWrite     true once `?token=...` supplied a non-empty bearer
 * @returns {string}             one-line subtitle (empty string if `showCreate`)
 */
export function createBugPanelSubtitle(showCreate, canWrite) {
  const showingForm = Boolean(showCreate);
  if (showingForm) {
    return 'Describe what\u2019s broken + how to reproduce. The supervisor picks the lowest-priority OPEN bug first.';
  }
  const writable = Boolean(canWrite);
  if (writable) {
    return 'Press the button to open the create form. Bugs land in `data/bugs.json` and become the supervisor\u2019s top priority until they ship.';
  }
  return 'Add `?token=***` to the URL (the api_token from config/user.json) to enable the create form. The bug list is public so you can preview what\u2019s already in the queue.';
}

/**
 * Header subtitle for the top-of-page BUGS panel (always rendered,
 * read-only). Lives next to the open / in-progress / shipped counters
 * so the operator can see the queue state without opening the form.
 *
 * @returns {string}
 */
export const BUGS_HEADER_SUBTITLE =
  'Operator-filed problems. The supervisor picks the lowest-priority OPEN bug first; if no bugs exist, it falls through to approved proposals.';

// ─────────────────────────────────────────────────────────────────────
//  Shipped-in placeholder detector
// ─────────────────────────────────────────────────────────────────────

/**
 * Returns true when `shipped_in` should render as a warning pill instead
 * of a normal commit-hash chip. The Bugs dashboard renders one row per
 * bug; a literal placeholder string (e.g. `<pending-commit-hash>`,
 * `TODO`, `FIXME`) used to render verbatim, making a shipped bug look
 * un-shipped to the operator. This helper centralizes the rule so the
 * JSX stays declarative and the unit tests lock the contract.
 *
 * Matches anything containing `<` or `>` (angle-bracket placeholders),
 * or any case-insensitive whole-word match against `pending`,
 * `placeholder`, `todo`, `fixme`. Coerces non-string inputs via
 * `String()` so callers don't need a defensive null-check; `null` /
 * `undefined` become the literal `'null'` / `'undefined'` which always
 * look like placeholders.
 *
 * @param {unknown} value  The raw `bug.shipped_in` value from the JSON.
 * @returns {boolean}       True if the value should render as a warning pill.
 */
export function isShippedInPlaceholder(value) {
  const v = String(value);
  return (
    v.includes('<')
    || v.includes('>')
    || /pending/i.test(v)
    || /\bplaceholder\b/i.test(v)
    || /\btodo\b/i.test(v)
    || /\bfixme\b/i.test(v)
  );
}
