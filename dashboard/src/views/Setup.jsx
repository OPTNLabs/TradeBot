// dashboard/src/views/Setup.jsx
//
// First-run SETUP wizard. Five steps:
//
//   1. NETWORK        mainnet vs chipnet (radio cards)
//   2. WALLET         generate fresh / import mnemonic / import WIF
//   3. TRADING        initial trading knobs (max position, exposure,
//                     take-profit, stop-loss, slippage, time-stop)
//   4. API TOKEN      optional; auto-generated if blank
//   5. REVIEW + APPLY submit, show generated mnemonic (if mode=generate),
//                     store api_token in sessionStorage, redirect to /
//
// The view is shown automatically when `GET /api/setup/status`
// returns `setup_required=true` (the App-level redirect handles
// that). It can also be opened manually at any time at `/setup` to
// re-run with a fresh wallet (the wizard will overwrite the
// existing config/user.json after a confirmation step).
//
// Data sources:
//   GET  /api/setup/status   check whether setup is required
//   POST /api/setup          apply the wizard payload
//
// No auto-refresh — this is a form, not a live view.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useApi } from '../lib/api-context.jsx';
import Panel from '../components/Panel.jsx';
import ErrorState from '../components/ErrorState.jsx';
import {
  NETWORK_OPTIONS,
  WALLET_MODE_OPTIONS,
  FIELD_BOUNDS,
  blankSetupDraft,
  validateSetupDraft,
  serializeSetupPayload,
} from './setup-helpers.mjs';

// ─── Style helpers ─────────────────────────────────────────────────

const inputBase = 'mt-1 w-full rounded border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-sm text-ash-100 focus:border-bch-500 focus:outline-none';
const labelBase = 'block text-xs font-mono uppercase tracking-wider text-ash-300';
const buttonPrimary = 'rounded bg-bch-500 px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-bch-400 disabled:opacity-50 disabled:cursor-not-allowed';
const buttonSecondary = 'rounded border border-ink-600 px-4 py-2 text-sm font-mono uppercase tracking-wider text-ash-200 hover:bg-ink-800 disabled:opacity-50 disabled:cursor-not-allowed';
const cardBase = 'rounded border border-ink-700 bg-ink-900/40 p-3 cursor-pointer hover:border-ink-500';
const cardSelected = 'rounded border-2 border-bch-500 bg-bch-950/30 p-3 cursor-pointer';

// ─── Sub-components ─────────────────────────────────────────────────

function FieldError({ msg }) {
  if (!msg) return null;
  return <div className="mt-1 text-xs text-amber-300">{msg}</div>;
}

function StepHeader({ step, title, subtitle }) {
  return (
    <div className="mb-3">
      <div className="text-xs font-mono uppercase tracking-wider text-bch-400">step {step} of 5</div>
      <h3 className="text-lg font-semibold text-ash-100">{title}</h3>
      {subtitle && <p className="mt-1 text-sm text-ash-400">{subtitle}</p>}
    </div>
  );
}

function NetworkStep({ draft, setDraft, errs }) {
  return (
    <div className="space-y-3">
      <StepHeader step={1} title="Choose a network"
        subtitle="Mainnet is real BCH. Chipnet is the BCH testnet — useful for a dry run before committing real funds." />
      <div className="grid gap-3 sm:grid-cols-2">
        {NETWORK_OPTIONS.map((opt) => {
          const selected = draft.network === opt.value;
          return (
            <label key={opt.value} className={selected ? cardSelected : cardBase}>
              <input type="radio" name="network" value={opt.value}
                className="sr-only"
                checked={selected}
                onChange={() => setDraft({ ...draft, network: opt.value })}
              />
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-semibold text-ash-100">{opt.label}</div>
                  <div className="mt-1 text-xs text-ash-400">{opt.description}</div>
                </div>
                {selected && <span className="ml-2 text-bch-400">✓</span>}
              </div>
            </label>
          );
        })}
      </div>
      <FieldError msg={errs.network} />
    </div>
  );
}

function WalletStep({ draft, setDraft, errs }) {
  return (
    <div className="space-y-3">
      <StepHeader step={2} title="Set up the wallet"
        subtitle="The bot needs a BCH wallet to sign trades. The WIF + (optionally) mnemonic are written to config/user.json (gitignored, chmod 600) and never leave the host." />
      <div className="space-y-2">
        {WALLET_MODE_OPTIONS.map((opt) => {
          const selected = draft.wallet_mode === opt.value;
          return (
            <label key={opt.value} className={selected ? cardSelected : cardBase}>
              <input type="radio" name="wallet_mode" value={opt.value}
                className="sr-only"
                checked={selected}
                onChange={() => setDraft({ ...draft, wallet_mode: opt.value })}
              />
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-semibold text-ash-100">{opt.label}</div>
                  <div className="mt-1 text-xs text-ash-400">{opt.description}</div>
                </div>
                {selected && <span className="ml-2 text-bch-400">✓</span>}
              </div>
            </label>
          );
        })}
      </div>

      {draft.wallet_mode === 'import_mnemonic' && (
        <div className="mt-3">
          <label className={labelBase}>
            BIP39 mnemonic
            <textarea
              rows={3}
              className={`${inputBase} resize-y`}
              placeholder="twelve or twenty-four words, separated by single spaces"
              value={draft.mnemonic}
              onChange={(e) => setDraft({ ...draft, mnemonic: e.target.value })}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div className="mt-1 text-xs text-ash-500">
            {String(draft.mnemonic || '').trim().split(/\s+/).filter(Boolean).length} word(s) ·
            {' '}12 / 15 / 18 / 21 / 24 accepted
          </div>
          <FieldError msg={errs.mnemonic} />
        </div>
      )}

      {draft.wallet_mode === 'import_wif' && (
        <div className="mt-3">
          <label className={labelBase}>
            Mainnet WIF
            <input
              type="text"
              className={inputBase}
              placeholder="K... or L..."
              value={draft.wif}
              onChange={(e) => setDraft({ ...draft, wif: e.target.value })}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div className="mt-1 text-xs text-ash-500">
            Starts with K or L · 51–52 base58 characters · checksum verified server-side.
          </div>
          <FieldError msg={errs.wif} />
        </div>
      )}
    </div>
  );
}

function NumberField({ id, draft, setDraft, err }) {
  const bounds = FIELD_BOUNDS[id];
  return (
    <label className={labelBase}>
      {bounds.label}
      <input
        type="number"
        step={bounds.kind === 'int' ? 1 : 'any'}
        min={bounds.min}
        max={bounds.max}
        className={inputBase}
        value={draft[id]}
        onChange={(e) => {
          const raw = e.target.value;
          const v = raw === '' ? NaN : Number(raw);
          setDraft({ ...draft, [id]: v });
        }}
      />
      <div className="mt-1 text-xs text-ash-500">
        range {bounds.min}–{bounds.max}
      </div>
      <FieldError msg={err} />
    </label>
  );
}

function TradingStep({ draft, setDraft, errs }) {
  return (
    <div className="space-y-3">
      <StepHeader step={3} title="Initial trading settings"
        subtitle="These are the small-balance-startup defaults. You can re-tune any of them later from the Settings view." />
      <div className="grid gap-3 sm:grid-cols-2">
        <NumberField id="max_position_bch" draft={draft} setDraft={setDraft} err={errs.max_position_bch} />
        <NumberField id="max_total_exposure_bch" draft={draft} setDraft={setDraft} err={errs.max_total_exposure_bch} />
        <NumberField id="take_profit_pct" draft={draft} setDraft={setDraft} err={errs.take_profit_pct} />
        <NumberField id="stop_loss_pct" draft={draft} setDraft={setDraft} err={errs.stop_loss_pct} />
        <NumberField id="slippage_tolerance_bps" draft={draft} setDraft={setDraft} err={errs.slippage_tolerance_bps} />
        <NumberField id="time_stop_hours" draft={draft} setDraft={setDraft} err={errs.time_stop_hours} />
      </div>
    </div>
  );
}

function TokenStep({ draft, setDraft, err }) {
  return (
    <div className="space-y-3">
      <StepHeader step={4} title="Dashboard API token"
        subtitle="Gates PUT /api/config and POST /api/risk/reset so only token-holders can edit your settings. Leave blank to auto-generate." />
      <label className={labelBase}>
        API token (optional — auto-generated if blank)
        <input
          type="text"
          className={inputBase}
          placeholder="leave blank to auto-generate"
          value={draft.api_token}
          onChange={(e) => setDraft({ ...draft, api_token: e.target.value })}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <div className="mt-1 text-xs text-ash-500">
        Save it somewhere safe — you'll need to pass it as <code className="num">?token=&lt;token&gt;</code> when opening the Settings view in write mode.
      </div>
      <FieldError msg={err} />
    </div>
  );
}

function ReviewStep({ draft, status }) {
  const rows = [
    { label: 'Network',                  value: draft.network },
    { label: 'Wallet mode',              value: draft.wallet_mode },
    { label: 'Max position size',        value: `${draft.max_position_bch} BCH` },
    { label: 'Max total exposure',       value: `${draft.max_total_exposure_bch} BCH` },
    { label: 'Take-profit',              value: `${draft.take_profit_pct}%` },
    { label: 'Stop-loss',                value: `${draft.stop_loss_pct}%` },
    { label: 'Slippage tolerance',       value: `${draft.slippage_tolerance_bps} bps` },
    { label: 'Time stop',                value: `${draft.time_stop_hours} h` },
    { label: 'API token',                value: draft.api_token ? '<custom>' : '<auto-generated>' },
  ];
  return (
    <div className="space-y-3">
      <StepHeader step={5} title="Review"
        subtitle="Click Apply to write config/user.json. The dashboard will reload into the normal view." />
      <div className="rounded border border-ink-700 bg-ink-900/30 p-3 text-sm">
        <table className="w-full text-left">
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-b border-ink-800 last:border-b-0">
                <td className="py-1.5 pr-3 text-xs font-mono uppercase tracking-wider text-ash-400">{r.label}</td>
                <td className="py-1.5 num text-ash-100">{r.value}</td>
              </tr>
            ))}
            {status?.cashaddr_display && (
              <tr className="border-b border-ink-800 last:border-b-0">
                <td className="py-1.5 pr-3 text-xs font-mono uppercase tracking-wider text-ash-400">Cashaddr</td>
                <td className="py-1.5 num text-ash-100">{status.cashaddr_display}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Main view ─────────────────────────────────────────────────────

const STEPS = ['network', 'wallet', 'trading', 'token', 'review'];

export default function Setup() {
  const { api, setToken } = useApi();
  const navigate = useNavigate();

  const [draft, setDraft] = useState(() => blankSetupDraft());
  const [stepIdx, setStepIdx] = useState(0);
  const [status, setStatus] = useState(null);     // GET /api/setup/status
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState(null);
  const [result, setResult] = useState(null);     // POST /api/setup response
  const [mnemonicAcked, setMnemonicAcked] = useState(false);

  // Pull setup status on mount so we can show "already configured"
  // gracefully (operator navigated to /setup manually).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await api.setupStatus();
      if (cancelled) return;
      if (r.ok && r.data) setStatus(r.data);
    })();
    return () => { cancelled = true; };
  }, [api]);

  // Validate the current step on every draft change. We run the
  // full-draft validator so cross-field checks (exposure ≥
  // position, TP > SL) still trip on the last step.
  const validation = useMemo(() => validateSetupDraft(draft), [draft]);
  const errs = useMemo(() => {
    if (validation.ok) return {};
    const out = {};
    for (const e of validation.errors) out[e.field] = e.message;
    return out;
  }, [validation]);

  const next = useCallback(() => {
    setStepIdx((i) => Math.min(i + 1, STEPS.length - 1));
  }, []);
  const back = useCallback(() => {
    setStepIdx((i) => Math.max(i - 1, 0));
  }, []);

  const apply = useCallback(async () => {
    setSubmitErr(null);
    if (!validation.ok) {
      setSubmitErr({ code: 'BAD_PAYLOAD', error: 'Form has validation errors', errors: validation.errors });
      setStepIdx(0);
      return;
    }
    setSubmitting(true);
    try {
      const payload = serializeSetupPayload(draft);
      const r = await api.setupApply(payload);
      if (r.ok) {
        setResult(r.data);
        // Stash the API token in sessionStorage so the Settings
        // view + risk-reset button get auth automatically.
        if (r.data?.api_token) {
          try { window.sessionStorage.setItem('tradebot.api_token', r.data.api_token); } catch (_) {}
          setToken(r.data.api_token);
        }
        // For generate-mode, force the operator to acknowledge the
        // mnemonic before bouncing to the dashboard.
        if (r.data?.generated_mnemonic) {
          setMnemonicAcked(false);
        }
      } else {
        setSubmitErr(r);
      }
    } catch (e) {
      setSubmitErr({ error: (e && e.message) || 'submit failed' });
    } finally {
      setSubmitting(false);
    }
  }, [api, draft, validation, setToken]);

  // After a successful submit + (if needed) mnemonic acknowledgement,
  // route back to the dashboard.
  const finish = useCallback(() => {
    navigate('/');
  }, [navigate]);

  // ── Success screen ─────────────────────────────────────────────
  if (result && (!result.generated_mnemonic || mnemonicAcked)) {
    return (
      <div className="mx-auto max-w-2xl">
        <Panel title="Setup complete">
          <div className="space-y-3">
            <div className="rounded border border-bch-700/60 bg-bch-950/30 p-4 text-sm text-bch-200">
              <div className="font-mono uppercase tracking-wider text-xs text-bch-400 mb-2">ready to trade</div>
              <div>config/user.json has been written. The bot now has a valid wallet + initial trading settings.</div>
            </div>
            {result.api_token && (
              <div className="rounded border border-ink-700 bg-ink-900/40 p-3">
                <div className="text-xs font-mono uppercase tracking-wider text-ash-300">Dashboard API token</div>
                <div className="mt-1 num text-sm text-ash-100 break-all select-all">{result.api_token}</div>
                <div className="mt-1 text-xs text-ash-500">
                  {result.api_token_auto_generated ? 'Auto-generated. ' : 'You-supplied. '}
                  Stored in sessionStorage for this tab. You'll need it to edit Settings or trigger risk resets.
                </div>
              </div>
            )}
            {Array.isArray(result.next_steps) && (
              <div className="rounded border border-ink-700 bg-ink-900/30 p-3">
                <div className="text-xs font-mono uppercase tracking-wider text-ash-300">Next steps</div>
                <ul className="mt-2 list-disc pl-5 text-sm text-ash-200 space-y-1">
                  {result.next_steps.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={finish} className={buttonPrimary}>
                Open dashboard
              </button>
            </div>
          </div>
        </Panel>
      </div>
    );
  }

  // ── Mnemonic acknowledgement (generate mode) ─────────────────
  if (result && result.generated_mnemonic && !mnemonicAcked) {
    const words = String(result.generated_mnemonic).split(/\s+/);
    return (
      <div className="mx-auto max-w-2xl">
        <Panel title="Save your mnemonic">
          <div className="space-y-3">
            <div className="rounded border border-amber-700/60 bg-amber-950/30 p-4 text-sm text-amber-200">
              <div className="font-mono uppercase tracking-wider text-xs text-amber-300 mb-2">important — shown once</div>
              <div>This is the recovery phrase for your bot's wallet. Write it down (or paste it into a password manager) before continuing. We do not store it in any retrievable form beyond config/user.json.</div>
            </div>
            <div className="rounded border border-ink-700 bg-ink-900/40 p-4">
              <div className="text-xs font-mono uppercase tracking-wider text-ash-300 mb-2">BIP39 mnemonic ({words.length} words)</div>
              <div className="num select-all break-words text-base leading-relaxed text-ash-100">
                {words.map((w, i) => (
                  <span key={i} className="mr-2 inline-block">
                    <span className="text-xs text-ash-500">{i + 1}.</span> {w}
                  </span>
                ))}
              </div>
            </div>
            <div className="rounded border border-ink-700 bg-ink-900/30 p-3">
              <div className="text-xs text-ash-400">Cashaddr</div>
              <div className="num mt-0.5 select-all text-sm text-ash-100">{result.cashaddr}</div>
              <div className="mt-2 text-xs text-ash-500">Fund this address with BCH before starting the trading loop.</div>
            </div>
            <div className="flex items-center justify-end gap-2">
              <label className="flex items-center gap-2 text-xs text-ash-300">
                <input type="checkbox" checked={mnemonicAcked} onChange={(e) => setMnemonicAcked(e.target.checked)} />
                I've saved the mnemonic
              </label>
              <button type="button" disabled={!mnemonicAcked} onClick={finish} className={buttonPrimary}>
                Open dashboard
              </button>
            </div>
          </div>
        </Panel>
      </div>
    );
  }

  // ── Wizard ────────────────────────────────────────────────────
  const step = STEPS[stepIdx];
  return (
    <div className="mx-auto max-w-2xl">
      <Panel
        title="First-run setup"
        subtitle="TradeBot isn't configured yet. Walk through these steps to write config/user.json (chmod 600, gitignored)."
        right={
          status && !status.setup_required
            ? <span className="text-bch-400">already configured</span>
            : <span className="text-amber-300">setup required</span>
        }
      >
        {/* Status / error banner */}
        {submitErr && (
          <ErrorState
            message={
              submitErr.error ||
              (Array.isArray(submitErr.errors) && submitErr.errors[0]?.message) ||
              'Submit failed.'
            }
          />
        )}

        {/* Step renderer */}
        <div className="mt-2">
          {step === 'network' && <NetworkStep draft={draft} setDraft={setDraft} errs={errs} />}
          {step === 'wallet'  && <WalletStep draft={draft} setDraft={setDraft} errs={errs} />}
          {step === 'trading' && <TradingStep draft={draft} setDraft={setDraft} errs={errs} />}
          {step === 'token'   && <TokenStep draft={draft} setDraft={setDraft} err={errs.api_token} />}
          {step === 'review'  && <ReviewStep draft={draft} status={status} />}
        </div>

        {/* Nav */}
        <div className="mt-4 flex items-center justify-between border-t border-ink-700 pt-3">
          <div className="text-xs text-ash-400">
            Step {stepIdx + 1} / {STEPS.length}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={back} disabled={stepIdx === 0 || submitting} className={buttonSecondary}>
              Back
            </button>
            {stepIdx < STEPS.length - 1 && (
              <button type="button" onClick={next} className={buttonPrimary}>
                Next
              </button>
            )}
            {stepIdx === STEPS.length - 1 && (
              <button type="button" onClick={apply} disabled={submitting || !validation.ok} className={buttonPrimary}>
                {submitting ? 'Applying…' : 'Apply'}
              </button>
            )}
          </div>
        </div>
      </Panel>
    </div>
  );
}