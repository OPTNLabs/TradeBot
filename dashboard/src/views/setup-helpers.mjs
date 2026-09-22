// dashboard/src/views/setup-helpers.mjs
//
// Pure helpers for the first-run Setup wizard. Same separation
// pattern as `dashboard/src/views/bugs-helpers.mjs` — keeps the
// JSX in `Setup.jsx` focused on rendering while the validation /
// normalization lives here where it can be unit-tested without
// React.
//
// Wizard fields (mirrors `src/dashboard/setup.mjs#SETUP_BOUNDS`):
//   - network           ('mainnet' | 'chipnet')
//   - wallet_mode       ('generate' | 'import_mnemonic' | 'import_wif')
//   - mnemonic          (12/15/18/21/24-word BIP39 phrase — required iff import_mnemonic)
//   - wif               (mainnet WIF, base58 — required iff import_wif)
//   - max_position_bch  (0.0001–1.0)
//   - max_total_exposure_bch (0.0005–5.0)
//   - take_profit_pct   (0.5–50.0)
//   - stop_loss_pct     (0.1–30.0)
//   - slippage_tolerance_bps (5–1000)
//   - time_stop_hours   (1–720)
//   - api_token         (optional; auto-fills with 64 hex chars if blank)

export const NETWORK_OPTIONS = Object.freeze([
  {
    value: 'mainnet',
    label: 'Mainnet (live BCH)',
    description: 'Real BCH. The bot trades against cauldron.quest mainnet. Use only with funds you can afford to lose.',
  },
  {
    value: 'chipnet',
    label: 'Chipnet (BCH testnet)',
    description: 'BCH testnet. No real money at stake. The bot will use the chipnet Electrum provider.',
  },
]);

export const WALLET_MODE_OPTIONS = Object.freeze([
  {
    value: 'generate',
    label: 'Generate a fresh wallet',
    description: 'Create a brand-new BIP39 mnemonic + WIF. The bot\'s wallet will be empty — fund it with BCH before starting the bot.',
  },
  {
    value: 'import_mnemonic',
    label: 'Import a BIP39 mnemonic',
    description: 'Restore from an existing 12/15/18/21/24-word BIP39 phrase.',
  },
  {
    value: 'import_wif',
    label: 'Import a WIF',
    description: 'Restore from a mainnet WIF. The mnemonic is NOT stored — only the WIF. Use this when you have a WIF-only backup.',
  },
]);

/** Field bounds — mirrors src/dashboard/setup.mjs#SETUP_BOUNDS. */
export const FIELD_BOUNDS = Object.freeze({
  max_position_bch:        { min: 0.0001, max: 1.0,    default: 0.005,   label: 'Max position size (BCH)' },
  max_total_exposure_bch:  { min: 0.0005, max: 5.0,    default: 0.04,    label: 'Max total exposure (BCH)' },
  take_profit_pct:         { min: 0.5,    max: 50.0,   default: 5.0,     label: 'Take-profit (%)' },
  stop_loss_pct:           { min: 0.1,    max: 30.0,   default: 3.0,     label: 'Stop-loss (%)' },
  slippage_tolerance_bps:  { min: 5,      max: 1000,   default: 100,     label: 'Slippage tolerance (bps)', kind: 'int' },
  time_stop_hours:         { min: 1,      max: 720,    default: 24,      label: 'Time stop (hours)', kind: 'int' },
});

/** Starting wizard state — every field at its default. */
export function blankSetupDraft() {
  return {
    network: 'mainnet',
    wallet_mode: 'generate',
    mnemonic: '',
    wif: '',
    max_position_bch:        FIELD_BOUNDS.max_position_bch.default,
    max_total_exposure_bch:  FIELD_BOUNDS.max_total_exposure_bch.default,
    take_profit_pct:         FIELD_BOUNDS.take_profit_pct.default,
    stop_loss_pct:           FIELD_BOUNDS.stop_loss_pct.default,
    slippage_tolerance_bps:  FIELD_BOUNDS.slippage_tolerance_bps.default,
    time_stop_hours:         FIELD_BOUNDS.time_stop_hours.default,
    api_token: '',
  };
}

/**
 * Validate the wizard's draft before submitting to the backend.
 * Mirrors the server-side `validateSetupPayload` so the user
 * gets fast feedback; the server re-validates independently.
 *
 * Returns `{ok:true}` or `{ok:false, errors:[{field, message}]}`.
 * Pure. Exported for tests.
 *
 * @param {Object} draft
 * @returns {{ok:true}|{ok:false, errors:Array}}
 */
export function validateSetupDraft(draft) {
  const errors = [];
  if (!draft || typeof draft !== 'object') {
    return { ok: false, errors: [{ field: '_root', message: 'draft required' }] };
  }

  if (!['mainnet', 'chipnet', 'mainnetUncompressed', 'testnet', 'testnetUncompressed'].includes(draft.network)) {
    errors.push({ field: 'network', message: 'Network is required.' });
  }

  if (!['generate', 'import_mnemonic', 'import_wif'].includes(draft.wallet_mode)) {
    errors.push({ field: 'wallet_mode', message: 'Wallet mode is required.' });
  } else {
    if (draft.wallet_mode === 'import_mnemonic') {
      const words = String(draft.mnemonic || '').trim().split(/\s+/).filter(Boolean);
      if (![12, 15, 18, 21, 24].includes(words.length)) {
        errors.push({ field: 'mnemonic', message: 'Mnemonic must be 12, 15, 18, 21, or 24 words.' });
      }
    }
    if (draft.wallet_mode === 'import_wif') {
      const wif = String(draft.wif || '').trim();
      // Base58 mainnet WIF: starts with K or L, length 51–52.
      if (!/^[KL][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(wif)) {
        errors.push({ field: 'wif', message: 'WIF must start with K or L and be 51–52 base58 characters.' });
      }
    }
  }

  for (const [field, bounds] of Object.entries(FIELD_BOUNDS)) {
    const v = draft[field];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      errors.push({ field, message: `${bounds.label} must be a number.` });
      continue;
    }
    if (bounds.kind === 'int' && !Number.isInteger(v)) {
      errors.push({ field, message: `${bounds.label} must be a whole number.` });
      continue;
    }
    if (v < bounds.min || v > bounds.max) {
      errors.push({ field, message: `${bounds.label} must be between ${bounds.min} and ${bounds.max}.` });
    }
  }

  // Sanity: exposure >= position.
  if (typeof draft.max_position_bch === 'number'
      && typeof draft.max_total_exposure_bch === 'number'
      && draft.max_total_exposure_bch < draft.max_position_bch) {
    errors.push({ field: 'max_total_exposure_bch', message: 'Max exposure must be ≥ max position.' });
  }

  // Sanity: take_profit > stop_loss.
  if (typeof draft.take_profit_pct === 'number'
      && typeof draft.stop_loss_pct === 'number'
      && draft.take_profit_pct <= draft.stop_loss_pct) {
    errors.push({ field: 'take_profit_pct', message: 'Take-profit must be > stop-loss.' });
  }

  if (draft.api_token && !/^[0-9a-fA-F]{8,256}$/.test(String(draft.api_token).trim())) {
    errors.push({ field: 'api_token', message: 'API token must be 8–256 hex characters (or leave blank to auto-generate).' });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}

/**
 * Trim + normalize the draft into the wire shape the backend
 * expects. Pure. Exported for tests.
 *
 * @param {Object} draft
 * @returns {Object}
 */
export function serializeSetupPayload(draft) {
  return {
    network: draft.network,
    wallet_mode: draft.wallet_mode,
    mnemonic: (draft.wallet_mode === 'import_mnemonic')
      ? String(draft.mnemonic || '').trim().split(/\s+/).filter(Boolean).join(' ')
      : undefined,
    wif: (draft.wallet_mode === 'import_wif')
      ? String(draft.wif || '').trim()
      : undefined,
    max_position_bch: Number(draft.max_position_bch),
    max_total_exposure_bch: Number(draft.max_total_exposure_bch),
    take_profit_pct: Number(draft.take_profit_pct),
    stop_loss_pct: Number(draft.stop_loss_pct),
    slippage_tolerance_bps: Number(draft.slippage_tolerance_bps),
    time_stop_hours: Number(draft.time_stop_hours),
    api_token: (typeof draft.api_token === 'string' && draft.api_token.trim().length > 0)
      ? draft.api_token.trim()
      : '',
  };
}