# Security Policy

## Threat model

TradeBot is a hot-wallet trading bot on BCH mainnet. The wallet it controls
holds BCH + BCH-issued CashTokens. Anyone who can read the wallet's WIF or
seed can drain it instantly — there is no password, no 2FA, no recovery delay.

**Adversaries we design against:**

1. **Repo leak** — code, configs, or runtime state pushed to a public location
   exposing the wallet's WIF or seed. Catastrophic.
2. **Host compromise** — attacker reads the bot's `~/.paytaca/` directory or
   the bot's `config/user.json` containing the WIF. Catastrophic.
3. **Process inspection** — another local user reads `/proc/<pid>/environ` or
   memory dumps the bot to extract the WIF. Catastrophic.
4. **Dependency compromise** — a malicious npm package harvests the WIF
   during `npm install` or at runtime. Catastrophic.
5. **Replay / front-running** — an attacker observes a pending trade and
   front-runs it on BCH. Bounded by `slippage_tolerance_bps`.

We do **not** defend against a fully compromised host kernel or hypervisor.
At that point, the wallet should be considered burned regardless.

## Non-negotiable rules

1. **No seeds, WIFs, mnemonics, or private keys in this repo.** Not in code,
   not in docs, not in commit messages, not in screenshots. The `.gitignore`
   blocks common paths. The pre-commit key-scan hook is mandatory.

2. **The wallet is throwaway.** If you suspect compromise, sweep to a fresh
   wallet immediately. Treat the WIF as already leaked at the first sign of
   host intrusion.

3. **`config/user.json` is gitignored.** It contains the WIF + RPC URL. Never
   force-add it. Never symlink it to a synced location (iCloud, Dropbox, etc.).

4. **`data/` is gitignored.** It contains positions, history, balance history.
   It may inadvertently contain transaction-derived metadata that helps a
   passive observer map the bot's activity. Keep it on the host only.

5. **`paytaca-cli` runs locally.** Do not run it on a remote server over an
   unencrypted channel. If you must, use SSH + a local socket.

6. **Dependency pinning.** All npm dependencies must be pinned to exact
   versions. No `^` or `~` ranges in `package.json`. Review every update.

7. **Pre-commit key-scan** blocks any commit matching these patterns:
   - WIF: `K[A-HJ-NP-Za-km-z1-9]{51}` or `L[A-HJ-NP-Za-km-z1-9]{51}`
   - BCH mnemonic: 12/15/18/21/24-word BIP39 lists
   - xprv / yprv / zprv extended keys
   - `PRIVATE_KEY=` or `WIF=` assignments in any file under 1 MB

## Reporting

If you find a security issue, do not open a public issue. Contact
[LifestoneLabs via the channels in their profile] with details.

## Wallet hygiene

- Start with a tiny balance (0.01 BCH). Scale up only after the bot has
  proven itself on chipnet + low-value mainnet runs.
- Sweep profits to a cold wallet weekly.
- Rotate the bot's wallet monthly if running in production.
