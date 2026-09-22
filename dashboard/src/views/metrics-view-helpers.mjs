// dashboard/src/views/metrics-view-helpers.mjs
//
// T79 subset 2 — Pure helpers for the `MetricsViewerCard.jsx`
// React tile. All exports are dependency-free so the helpers
// can be unit-tested without booting React.

/**
 * Parse a Prometheus text-format body into structured metric
 * blocks. The parser is intentionally minimal — it doesn't
 * attempt to validate the entire Prometheus spec, just the
 * subset the TradeBot `/metrics` endpoint emits:
 *   - HELP lines (`# HELP <name> <text>`)
 *   - TYPE lines (`# TYPE <name> <counter|gauge|histogram|...>`)
 *   - Sample lines (`<name>{label="value",...} <value>`)
 *   - Comment lines (`# ...`)
 *   - Blank lines (separator)
 *
 * Defensive: every line is parsed defensively; a malformed
 * line is silently dropped (the parser never throws).
 *
 * @param {string|null|undefined} text
 * @returns {Array<{
 *   name: string,
 *   type: string,
 *   help: string,
 *   samples: Array<{ labels: Record<string, string>, value: string }>,
 * }>}
 */
export function parsePrometheusText(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  /** @type {Map<string, any>} */
  const blocks = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith('# HELP ')) {
      const after = line.slice('# HELP '.length);
      const sp = after.indexOf(' ');
      if (sp <= 0) continue;
      const name = after.slice(0, sp).trim();
      const help = after.slice(sp + 1).trim();
      const existing = blocks.get(name) ?? { name, type: '', help: '', samples: [] };
      existing.help = help;
      blocks.set(name, existing);
      continue;
    }
    if (line.startsWith('# TYPE ')) {
      const after = line.slice('# TYPE '.length);
      const sp = after.indexOf(' ');
      if (sp <= 0) continue;
      const name = after.slice(0, sp).trim();
      const type = after.slice(sp + 1).trim();
      const existing = blocks.get(name) ?? { name, type: '', help: '', samples: [] };
      existing.type = type;
      blocks.set(name, existing);
      continue;
    }
    if (line.startsWith('#')) continue; // generic comment
    // Sample line: `<name>{labels} <value>` or `<name> <value>`.
    // Find the first `{` (label block) or first space (no labels).
    const braceAt = line.indexOf('{');
    const spaceAt = line.indexOf(' ');
    let name;
    let labelsStr = '';
    if (braceAt >= 0 && (spaceAt < 0 || braceAt < spaceAt)) {
      name = line.slice(0, braceAt).trim();
      const close = line.indexOf('}', braceAt);
      if (close < 0) continue; // malformed
      labelsStr = line.slice(braceAt + 1, close);
    } else if (spaceAt > 0) {
      name = line.slice(0, spaceAt).trim();
    } else {
      continue; // malformed
    }
    const valuePart = line.slice(line.indexOf(' ', (braceAt >= 0 ? braceAt + 1 : 0)) + 1).trim();
    if (!name) continue;
    // Split into value + optional timestamp (we ignore the timestamp).
    const valueStr = valuePart.split(/\s+/)[0];
    const labels = parseLabelsString(labelsStr);
    const existing = blocks.get(name) ?? { name, type: '', help: '', samples: [] };
    existing.samples.push({ labels, value: valueStr });
    blocks.set(name, existing);
  }
  return Array.from(blocks.values());
}

/**
 * Parse the inside of a Prometheus label block
 * (`key="value",key2="value2"`). Quoted values; commas separate
 * pairs; whitespace tolerated. Defensive: malformed pairs are
 * silently dropped.
 *
 * @param {string} raw
 * @returns {Record<string, string>}
 */
export function parseLabelsString(raw) {
  /** @type {Record<string, string>} */
  const out = {};
  if (typeof raw !== 'string' || raw.length === 0) return out;
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && (raw[i] === ' ' || raw[i] === ',')) i += 1;
    const eq = raw.indexOf('=', i);
    if (eq < 0) break;
    const key = raw.slice(i, eq).trim();
    i = eq + 1;
    if (raw[i] !== '"') break;
    i += 1;
    let value = '';
    while (i < raw.length && raw[i] !== '"') {
      if (raw[i] === '\\' && i + 1 < raw.length) {
        const next = raw[i + 1];
        if (next === 'n') value += '\n';
        else if (next === '"') value += '"';
        else if (next === '\\') value += '\\';
        else value += next;
        i += 2;
      } else {
        value += raw[i];
        i += 1;
      }
    }
    if (raw[i] === '"') i += 1;
    if (key.length > 0) out[key] = value;
  }
  return out;
}

/**
 * Summarize a set of metric blocks for the tile header (total
 * series, total samples, `tradebot_up` value, last-tick count).
 * Returns zero / null values when no blocks are available so
 * the caller can render header chips unconditionally.
 *
 * @param {Array<any>} blocks
 * @returns {{
 *   totalSeries: number,
 *   totalSamples: number,
 *   upValue: number|null,
 *   tickCount: number|null,
 * }}
 */
export function summarizeMetricBlocks(blocks) {
  if (!Array.isArray(blocks)) {
    return { totalSeries: 0, totalSamples: 0, upValue: null, tickCount: null };
  }
  let totalSamples = 0;
  let upValue = null;
  let tickCount = null;
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    if (Array.isArray(b.samples)) totalSamples += b.samples.length;
    if (b.name === 'tradebot_up' && Array.isArray(b.samples) && b.samples.length > 0) {
      const v = Number(b.samples[0].value);
      if (Number.isFinite(v)) upValue = v;
    }
    if (b.name === 'tradebot_loop_tick_count_total' && Array.isArray(b.samples)) {
      for (const s of b.samples) {
        const v = Number(s.value);
        if (Number.isFinite(v)) {
          tickCount = (tickCount ?? 0) + v;
        }
      }
    }
  }
  return { totalSeries: blocks.length, totalSamples, upValue, tickCount };
}

/**
 * Group metric blocks by their `<prefix>_<subject>` prefix.
 * For `tradebot_loop_*`, the prefix is `tradebot_loop`; for
 * `tradebot_token_*`, `tradebot_token`; etc. Returns groups
 * sorted by prefix ascending so the dashboard renders the same
 * order on every refresh.
 *
 * @param {Array<{name: string}>} blocks
 * @returns {Array<{
 *   prefix: string,
 *   series: Array<any>,
 *   seriesCount: number,
 * }>}
 */
export function groupByPrefix(blocks) {
  if (!Array.isArray(blocks)) return [];
  /** @type {Map<string, any[]>} */
  const m = new Map();
  for (const b of blocks) {
    if (!b || typeof b.name !== 'string') continue;
    const name = b.name;
    // The "prefix" is the longest `_`-separated prefix that
    // matches `<namespace>_<topic>` for the well-known set;
    // for everything else we use the namespace (e.g. "tradebot").
    const prefix = deriveMetricPrefix(name);
    let arr = m.get(prefix);
    if (!arr) {
      arr = [];
      m.set(prefix, arr);
    }
    arr.push(b);
  }
  return Array.from(m.entries())
    .map(([prefix, series]) => ({ prefix, series, seriesCount: series.length }))
    .sort((a, b) => a.prefix.localeCompare(b.prefix));
}

/**
 * Derive the rendering prefix for a metric name. Pulls off the
 * last `_` segment when it looks like a measurement leaf (e.g.
 * `_total`, `_count`, `_ms`, `_bch`, `_seconds`, `_pct`),
 * otherwise uses the first two segments (`namespace_topic`).
 *
 * @param {string} name
 * @returns {string}
 */
export function deriveMetricPrefix(name) {
  if (typeof name !== 'string') return '';
  const parts = name.split('_');
  if (parts.length < 2) return name;
  const leaf = parts[parts.length - 1];
  // If the leaf looks like a measurement suffix, strip it.
  if (/^(total|count|sum|bucket|ms|seconds|bch|sats|pct|gauge|counter|histogram|summary)$/i.test(leaf)) {
    parts.pop();
  }
  if (parts.length < 2) return name;
  return parts.slice(0, 2).join('_');
}

/**
 * Returns true when the body is missing / empty / parseable
 * into zero blocks. Used by the React tile to decide between
 * the table view and the "unavailable" pill.
 *
 * @param {string|null|undefined} text
 * @returns {boolean}
 */
export function isMetricsUnavailable(text) {
  if (typeof text !== 'string' || text.length === 0) return true;
  // Quick sanity: a parseable Prometheus body always has at
  // least one `# HELP` / `# TYPE` / sample line.
  return parsePrometheusText(text).length === 0;
}

/**
 * Extract a human-readable error message from the API result
 * or from the raw text body when the parse failed.
 *
 * @param {string|null} err — request error string
 * @param {string|null} text — raw body
 * @returns {string|null}
 */
export function metricsErrorMessage(err, text) {
  if (err && typeof err === 'string') return err;
  if (typeof text !== 'string' || text.length === 0) return null;
  // Look for `# ERROR ...` lines (the server emits them when
  // the envelope builder explodes — see `buildMetricsEnvelope`
  // catch branch).
  const m = text.match(/^# ERROR ([^\n]+)/m);
  if (m) return m[1];
  return null;
}

/**
 * One-line explanation surfaced in the "unavailable" pill —
 * tells the operator what to do next. Static — the React tile
 * swaps this for `metricsErrorMessage()` when present.
 *
 * @param {string|null} text — raw body
 * @returns {string}
 */
export function metricsHelpText(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return 'The /metrics endpoint returned an empty body. Check that the bot is running and that the dashboard is wired to the same process.';
  }
  return 'The /metrics endpoint returned text that did not parse as Prometheus format. Click "show raw" to inspect the response.';
}