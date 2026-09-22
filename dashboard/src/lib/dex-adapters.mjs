// dashboard/src/lib/dex-adapters.mjs
//
// Browser-safe mirror of `src/dex/adapter.mjs#DEX_REGISTRY` ids.
//
// Why this exists: the Settings view needs to render a toggle list
// of every DEX adapter the bot knows about. Importing `listKnownDexIds`
// directly from `src/dex/adapter.mjs` would pull in the server-side
// cauldron.mjs / cauldron-safe-mode.mjs / guanaco.mjs adapter
// factories, which use node:fs + node:path and break the Vite
// browser build (these are server-only modules).
//
// Trade-off: this list is a hand-maintained mirror of the
// canonical `DEX_REGISTRY` ids. The list is small and stable
// (currently 3 entries: cauldron, cauldron_safe_mode, guanaco)
// so drift risk is low; if a new adapter is added to
// src/dex/adapter.mjs, add its id here in the same order so the
// dashboard's toggle list stays in lockstep with the boot-time
// registry.
//
// The canonical source of truth is `src/dex/adapter.mjs#DEX_REGISTRY`.
// Adding a new adapter = add an entry there + add the id here in
// the same position (registry order = canonical order, used by the
// Settings toggle to preserve stable save payloads).

export const KNOWN_DEX_IDS = Object.freeze([
  'cauldron',
  'cauldron_safe_mode',
  'guanaco',
]);

export const KNOWN_DEX_DISPLAY_NAMES = Object.freeze({
  cauldron: 'Cauldron',
  cauldron_safe_mode: 'Cauldron (Safe Mode)',
  guanaco: 'Guanaco',
});
