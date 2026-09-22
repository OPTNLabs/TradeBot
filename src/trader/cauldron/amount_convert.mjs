// Copied from LifestoneLabs/AI_Skills @ 5640eda484557b7af0105ed09ad3951620e39c17
// Original source: skills/cauldron/scripts/amount_convert.mjs
//
// Trimmed for in-process library use by TradeBot:
//   - shebang + main() + the CLI usage / exit-code paths removed
//   - console.log/error calls removed (the bot uses the structured logger)
//   - BCMR resolution is exposed via `convertAmount` which takes either a
//     resolved BCMR body OR a token_id and resolves it itself
//
// Exports: parseArgs, normalizeTokenId, humanToBase, baseToHuman,
// detectUnits, resolveBcmr (re-exported), resolveSymbolToId (re-exported).

export {
  parseArgs,
  normalizeTokenId,
  fetchWithTimeout,
  resolveBcmr,
  resolveSymbolToId,
  INDEXER_HOSTS,
  INDEXER_CHIPNET_HOSTS,
  INDEXER_DISCOVERY,
  PREFER_REGEX,
} from './get_bcmr.mjs';

/**
 * Convert a human-units string ("10.5", "0.01", "12345") to base units.
 *
 * @param {string} humanStr  The amount in human units (decimal string).
 * @param {number} decimals  The BCMR decimals (>= 0).
 * @returns {bigint}         The amount in base units.
 */
export function humanToBase(humanStr, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`decimals must be a non-negative integer; got ${decimals}`);
  }
  const trimmed = String(humanStr).trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`--amount="${humanStr}" is not a valid decimal number`);
  }
  const negative = trimmed.startsWith('-');
  if (negative) {
    throw new Error(`--amount must be non-negative; got "${humanStr}"`);
  }
  const [intPart, fracPart = ''] = trimmed.split('.');
  // Pad / truncate the fractional part to exactly `decimals` digits.
  const paddedFrac = (fracPart + '0'.repeat(decimals)).slice(0, decimals);
  // Combined integer string: e.g. "10" + "50" → "1050" for decimals=2.
  const combined = (intPart + paddedFrac).replace(/^0+(?=\d)/, '') || '0';
  return BigInt(combined);
}

/**
 * Convert base units (BigInt) to a human-units display string.
 *
 * @param {bigint} base      The amount in base units.
 * @param {number} decimals  The BCMR decimals.
 * @param {number} padFrac   How many fractional digits to display (default = decimals).
 *                           Set to 0 to suppress fractional digits entirely.
 * @returns {string}         The amount in human units, with `padFrac` fractional digits.
 */
export function baseToHuman(base, decimals, padFrac = decimals) {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`decimals must be a non-negative integer; got ${decimals}`);
  }
  if (base < 0n) throw new Error(`base amount must be non-negative; got ${base}`);
  if (decimals === 0) {
    return padFrac <= 0
      ? base.toString()
      : `${base.toString()}.${'0'.repeat(padFrac)}`;
  }
  const s = base.toString().padStart(decimals + 1, '0');
  const intPart = s.slice(0, -decimals) || '0';
  const fracPart = s.slice(-decimals);
  if (padFrac <= 0) return intPart;
  if (padFrac <= decimals) {
    return `${intPart}.${fracPart.slice(0, padFrac)}`;
  }
  // padFrac > decimals — extend with trailing zeros.
  return `${intPart}.${fracPart}${'0'.repeat(padFrac - decimals)}`;
}

/**
 * Detect whether an amount string is in human (decimal) units or base (integer) units.
 * Pure heuristic: presence of a '.' or 'e'/'E' → human.
 */
export function detectUnits(amountStr) {
  const s = String(amountStr).trim();
  if (s.includes('.') || /e/i.test(s)) return 'human';
  return 'base';
}