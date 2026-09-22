// dashboard/src/views/manual-trade-helpers.mjs
//
// Pure helpers backing the manual-trade panel (T45b). Mirrors the
// `proposals-helpers.mjs` / `bugs-helpers.mjs` / `risk-panel-helpers.mjs`
// pattern: every non-trivial helper is extracted here so it can be
// tested under `node --test` without touching React or jsdom.
//
// Five surfaces:
//   - `emptyManualDraft()`            initial form state
//   - `validateManualDraft(draft)`    returns an array of error
//                                      strings (empty = valid)
//   - `buildManualTradeBody(draft)`   turns a valid draft into the
//                                      POST /api/trade/manual body
//   - `filterPoolOptions(opts,q)`     case-insensitive substring
//                                      filter for the autocomplete
//   - `formatManualQuote(result,side)` pretty-prints the pre-flight
//                                      quote + result envelope so the
//                                      operator can see slippage /
//                                      lpFee / networkFee / balance-
//                                      after before they confirm
//
// Design notes:
//   - The draft state is intentionally plain (object-of-primitives
//     + nested `selectedPool`) so a future "save draft to
//     localStorage" feature can serialize it without a custom
//     reviver. React mutability semantics require the panel
//     component to clone the object on every update.
//   - The body shape mirrors `parseManualTradeRequest` in
//     `src/dashboard/server.mjs` 1:1 — if the server adds a new
//     required field, this file should gain a matching helper.
//   - Validation is intentionally tolerant: a missing `expected_rate`
//     is fine (the executor falls back to the SDK's spot rate),
//     but a malformed `token_id` (anything that isn't 64 hex) is a
//     hard reject so the autocomplete state can't slip past the
//     backend's BAD_BODY gate with a typo.
//   - `filterPoolOptions` matches on `label` (symbol-or-truncated-id),
//     `symbol`, and `token_id` so typing either `NWB` or
//     `9a4b...` finds the same pool.

/**
 * Default shape for a brand-new draft. Kept in one place so a
 * future refactor that adds a field doesn't drift between the
 * initial-state call site and the `Reset` button.
 *
 * @returns {{
 *   side: 'buy'|'sell',
 *   tokenIdInput: string,
 *   selectedPool: {token_id: string, symbol: string|null, decimals: number|null, name: string|null, tvl_sats: number|null, trade_volume: number|null}|null,
 *   amountBch: string,
 *   expectedRate: string,
 *   dryRun: boolean,
 * }}
 */
export function emptyManualDraft() {
  return {
    side: 'buy',
    tokenIdInput: '',
    selectedPool: null,
    amountBch: '',
    expectedRate: '',
    dryRun: true,
  };
}

/**
 * Token-id validator used by both the autocomplete (to verify a
 * pasted value) and the body builder (to verify the final draft).
 * Lower-cases the input — matches the server's `tidRaw.toLowerCase()`
 * normalization so the wire shape is identical.
 *
 * @param {unknown} raw
 * @returns {string|null}  normalized token_id, or null if invalid
 */
export function normalizeManualTokenId(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length !== 64) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

/**
 * Validate a manual-trade draft. Returns an empty array when the
 * draft is ready to send; otherwise returns one string per
 * problem (so the React layer can render them all at once rather
 * than chasing errors field-by-field).
 *
 * @param {unknown} draft
 * @returns {string[]}
 */
export function validateManualDraft(draft) {
  const errs = [];
  if (!draft || typeof draft !== 'object') {
    return ['draft must be an object'];
  }
  /** @type {any} */
  const d = draft;
  // Side: buy or sell.
  if (d.side !== 'buy' && d.side !== 'sell') {
    errs.push(`side must be 'buy' or 'sell' (got ${JSON.stringify(d.side)})`);
  }
  // Token: either a valid pool object or a parseable 64-hex string.
  const tid = normalizeManualTokenId(d.tokenIdInput);
  const hasPool = (d.selectedPool && typeof d.selectedPool === 'object' && typeof d.selectedPool.token_id === 'string');
  if (tid === null && !hasPool) {
    errs.push('token_id must be a 64-hex category id or a pool picked from the list');
  } else if (tid !== null && hasPool && tid !== String(d.selectedPool.token_id).toLowerCase()) {
    errs.push('pasted token_id does not match the selected pool');
  }
  // Amount: positive finite number. Accept strings (the form
  // input is always a string) but reject non-finite / ≤ 0.
  const amt = Number(d.amountBch);
  if (!Number.isFinite(amt) || amt <= 0) {
    errs.push(`amount_bch must be a positive number (got ${JSON.stringify(d.amountBch)})`);
  }
  // Expected rate: optional, but when present must be positive
  // finite. The dashboard pre-fills it from the indexer's spot
  // price so most operators never touch the field; the validator
  // still rejects NaN / negative so a paste error doesn't slip
  // through.
  if (d.expectedRate !== '' && d.expectedRate !== null && d.expectedRate !== undefined) {
    const r = Number(d.expectedRate);
    if (!Number.isFinite(r) || r <= 0) {
      errs.push(`expected_rate_sats_per_token must be a positive number when present (got ${JSON.stringify(d.expectedRate)})`);
    }
  }
  return errs;
}

/**
 * Build the POST /api/trade/manual body from a validated draft.
 *
 * @param {unknown} draft
 * @returns {{ token_id: string, side: 'buy'|'sell', amount_bch: number, dry_run: boolean, expected_rate_sats_per_token?: number }|null}
 *   null if the draft doesn't validate (defensive — the panel
 *   shouldn't call this when `validateManualDraft` is non-empty,
 *   but we refuse rather than emit a malformed body).
 */
export function buildManualTradeBody(draft) {
  const errs = validateManualDraft(draft);
  if (errs.length > 0) return null;
  /** @type {any} */
  const d = draft;
  const tid = (typeof d.selectedPool?.token_id === 'string')
    ? String(d.selectedPool.token_id).toLowerCase()
    : normalizeManualTokenId(d.tokenIdInput);
  if (tid === null) return null;
  const body = {
    token_id: tid,
    side: d.side,
    amount_bch: Number(d.amountBch),
    dry_run: d.dryRun === true,
  };
  if (d.expectedRate !== '' && d.expectedRate !== null && d.expectedRate !== undefined) {
    const r = Number(d.expectedRate);
    if (Number.isFinite(r) && r > 0) {
      body.expected_rate_sats_per_token = r;
    }
  }
  return body;
}

/**
 * Build a short label for an autocomplete option. Falls back to a
 * truncated token_id when no symbol/name is available (the common
 * case for tokens without an authchain commit).
 *
 * @param {{token_id: string, symbol: string|null, name: string|null, tvl_sats: number|null}} opt
 * @returns {string}
 */
export function poolOptionLabel(opt) {
  if (!opt || typeof opt !== 'object') return '';
  const sym = (typeof opt.symbol === 'string' && opt.symbol.length > 0) ? opt.symbol : null;
  const name = (typeof opt.name === 'string' && opt.name.length > 0) ? opt.name : null;
  const tid = (typeof opt.token_id === 'string') ? opt.token_id : '';
  if (sym && name) return `${sym} · ${name}`;
  if (sym) return sym;
  if (name) return name;
  if (tid.length === 64) return tid.slice(0, 10) + '…';
  // Garbage-shape entry — return empty string rather than '…'
  // (which looks like a truncated id but is just the ellipsis).
  return '';
}

/**
 * Build the secondary hint line shown under each autocomplete
 * option. We surface the TVL so the operator can spot the active
 * pools at a glance without expanding the option.
 *
 * @param {{token_id: string, symbol: string|null, name: string|null, tvl_sats: number|null, trade_volume: number|null, decimals: number|null}} opt
 * @returns {string}
 */
export function poolOptionHint(opt) {
  if (!opt || typeof opt !== 'object') return '';
  const parts = [];
  if (Number.isFinite(opt.tvl_sats) && opt.tvl_sats !== null) {
    parts.push(`tvl ${formatSatsShort(opt.tvl_sats)}`);
  }
  if (Number.isFinite(opt.trade_volume) && opt.trade_volume !== null) {
    parts.push(`vol ${formatSatsShort(opt.trade_volume)}`);
  }
  const tid = (typeof opt.token_id === 'string') ? opt.token_id : '';
  if (tid.length === 64) {
    parts.push(tid.slice(0, 12) + '…');
  }
  return parts.join(' · ');
}

/**
 * Compact sats formatter for the autocomplete hint. Mirrors
 * `formatSats` in `lib/format.mjs` but trimmed down so it doesn't
 * import the dashboard's formatter (the manual-trade panel is
 * usable in isolation).
 *
 * @param {number|string|bigint} sats
 * @returns {string}
 */
export function formatSatsShort(sats) {
  // Explicit null / undefined / non-numeric guard — `Number(null)`
  // is `0` which would otherwise render as '0 sat' and look like a
  // legitimate zero rather than a missing value.
  if (sats === null || sats === undefined) return '—';
  const n = (typeof sats === 'bigint') ? Number(sats) : Number(sats);
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)} BCH`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} M sat`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} k sat`;
  return `${Math.round(n)} sat`;
}

/**
 * Case-insensitive substring filter for autocomplete options.
 * Matches on `label`, `symbol`, AND `token_id` so the operator
 * can search by either name.
 *
 * @param {Array<{token_id: string, symbol: string|null, name: string|null, tvl_sats: number|null, trade_volume: number|null}>} options
 * @param {string} query
 * @returns {Array<...>}
 */
export function filterPoolOptions(options, query) {
  if (!Array.isArray(options)) return [];
  const q = (typeof query === 'string') ? query.trim().toLowerCase() : '';
  if (q.length === 0) return options.slice(0, 50);
  return options.filter((opt) => {
    if (!opt || typeof opt !== 'object') return false;
    const tid = (typeof opt.token_id === 'string') ? opt.token_id.toLowerCase() : '';
    const sym = (typeof opt.symbol === 'string') ? opt.symbol.toLowerCase() : '';
    const name = (typeof opt.name === 'string') ? opt.name.toLowerCase() : '';
    return tid.includes(q) || sym.includes(q) || name.includes(q);
  }).slice(0, 50);
}

/**
 * Format a swap result envelope as a human-readable quote preview
 * for the operator. Returns a plain object so the React layer
 * can choose how to render (the panel uses a definition list).
 *
 * @param {Object|null|undefined} result
 * @param {'buy'|'sell'} side
 * @returns {{
 *   ok: boolean,
 *   errorKind: string|null,
 *   errorMessage: string|null,
 *   rateLabel: string|null,
 *   amountLabel: string|null,
 *   slippageLabel: string|null,
 *   lpFeeLabel: string|null,
 *   networkFeeLabel: string|null,
 *   balanceAfterLabel: string|null,
 *   txid: string|null,
 *   isDryRun: boolean,
 * }}
 */
export function formatManualQuote(result, side) {
  if (!result || typeof result !== 'object') {
    return {
      ok: false,
      errorKind: null,
      errorMessage: 'no result',
      rateLabel: null,
      amountLabel: null,
      slippageLabel: null,
      lpFeeLabel: null,
      networkFeeLabel: null,
      balanceAfterLabel: null,
      txid: null,
      isDryRun: false,
    };
  }
  /** @type {any} */
  const r = result;
  // The backend's `executeManualTrade` translates the bigint fields
  // to decimal-strings so JSON.stringify stays lossless. Re-parse
  // them here so the formatters don't have to know about the wire
  // shape.
  const effectiveRate = (typeof r.effectiveRateSats === 'string' || typeof r.effectiveRateSats === 'number')
    ? Number(r.effectiveRateSats) : null;
  const slippageBps = (typeof r.slippageBps === 'string' || typeof r.slippageBps === 'number')
    ? Number(r.slippageBps) : null;
  const totalSats = (typeof r.totalSatsInOrOut === 'string' || typeof r.totalSatsInOrOut === 'number')
    ? Number(r.totalSatsInOrOut) : null;
  const lpFeeSats = (typeof r.lpFeeSats === 'string' || typeof r.lpFeeSats === 'number')
    ? Number(r.lpFeeSats) : null;
  const networkFeeSats = (typeof r.estNetworkFeeSats === 'string' || typeof r.estNetworkFeeSats === 'number')
    ? Number(r.estNetworkFeeSats) : null;
  const balanceAfter = (typeof r.walletBalanceAfterSats === 'string' || typeof r.walletBalanceAfterSats === 'number')
    ? Number(r.walletBalanceAfterSats) : null;
  return {
    ok: r.ok === true,
    errorKind: typeof r.errorKind === 'string' ? r.errorKind : null,
    errorMessage: typeof r.error === 'string' ? r.error : null,
    rateLabel: (effectiveRate !== null && Number.isFinite(effectiveRate))
      ? `${effectiveRate.toFixed(2)} sat/token` : null,
    amountLabel: (totalSats !== null && Number.isFinite(totalSats))
      ? `${side === 'buy' ? 'spent' : 'received'} ${formatSatsShort(totalSats)}` : null,
    slippageLabel: (slippageBps !== null && Number.isFinite(slippageBps))
      ? `${slippageBps} bps` : null,
    lpFeeLabel: (lpFeeSats !== null && Number.isFinite(lpFeeSats))
      ? `${formatSatsShort(lpFeeSats)}` : null,
    networkFeeLabel: (networkFeeSats !== null && Number.isFinite(networkFeeSats))
      ? `~${formatSatsShort(networkFeeSats)}` : null,
    balanceAfterLabel: (balanceAfter !== null && Number.isFinite(balanceAfter))
      ? `${formatSatsShort(balanceAfter)}` : null,
    txid: typeof r.txid === 'string' ? r.txid : null,
    isDryRun: false, // overwritten by the caller when wrapping a dry-run envelope
  };
}

/**
 * Decide whether the manual-trade UI should surface an "execute"
 * button based on the current draft. Used by the panel's button
 * disabled-state. Mirrors the same shape the backend's
 * `preFlightCheck` enforces — the UI mirror is for UX only; the
 * backend is still the source of truth.
 *
 * @param {unknown} draft
 * @returns {boolean}
 */
export function canExecuteManualTrade(draft) {
  const errs = validateManualDraft(draft);
  return errs.length === 0;
}
