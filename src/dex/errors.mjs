#!/usr/bin/env node
// src/dex/errors.mjs
//
// Shared error classes for the DEX adapter layer. Lives in its
// own module so both `src/dex/adapter.mjs` (the registry) and
// every per-adapter file (cauldron.mjs, cauldron-safe-mode.mjs,
// guanaco.mjs, ...) can import without circular dependency:
//
//   adapter.mjs ─┐                  ┌── cauldron.mjs
//                ├──> errors.mjs <──┤
//   guanaco.mjs ─┘                  └── cauldron-safe-mode.mjs
//
// Originally DexAdapterError was defined inline in adapter.mjs;
// that worked while adapter.mjs only depended on cauldron.mjs +
// cauldron-safe-mode.mjs (both leaf modules). When guanaco.mjs
// subclassed DexAdapterError + adapter.mjs imported the
// guanaco factory, the circular import broke the registry
// initialization (the `factory` binding in DEX_REGISTRY resolved
// to `undefined` at module load time). Extracting the error
// class to its own leaf module fixes the cycle.

/**
 * Base error for every DEX-adapter layer failure. Per-adapter
 * errors subclass this so the trader loop can catch `err
 * instanceof DexAdapterError` and log a structured `dex.*` event
 * without having to special-case each adapter.
 */
export class DexAdapterError extends Error {
  /**
   * @param {string} message
   * @param {{ id?: string, cause?: unknown, code?: string }} [opts]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'DexAdapterError';
    this.id = opts.id ?? null;
    this.cause = opts.cause;
    this.code = opts.code ?? 'dex_adapter_error';
  }
}
