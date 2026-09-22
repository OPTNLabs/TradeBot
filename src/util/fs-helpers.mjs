#!/usr/bin/env node
// src/util/fs-helpers.mjs
//
// Tiny file-system helpers used by the entry-point scripts
// (run-bot, init-wallet, snapshot). Nothing fancy — just the
// handful of fs operations the scripts need that aren't already
// covered by `src/util/atomic-write.mjs`.
//
// Design rules:
//
//   1. **Injectable `fs`.** Every helper accepts an `fs` argument
//      defaulting to `node:fs/promises`. Tests inject throwaway
//      `memfs` fixtures.
//
//   2. **Never throw on ENOENT.** `pathExists`, `readJsonIfExists`
//      and friends return `null`/false for missing paths instead
//      of throwing — the caller's null check is enough.
//
//   3. **No `console.log`.** These helpers are pure — no logging,
//      no I/O surprise.

import { promises as fsp } from 'node:fs';
import path from 'node:path';

/**
 * Check whether `p` exists on disk (any file type — regular, dir,
 * socket, etc.). Returns `false` on ENOENT; throws on permission
 * errors / other I/O failures (those are programming bugs).
 *
 * @param {string} p
 * @param {typeof import('node:fs/promises')} [fs]
 * @returns {Promise<boolean>}
 */
export async function pathExists(p, fs = fsp) {
  if (typeof p !== 'string' || p.length === 0) return false;
  try {
    await fs.access(p);
    return true;
  } catch (e) {
    if (e && typeof e === 'object' && /** @type {any} */ (e).code === 'ENOENT') return false;
    throw e;
  }
}

/**
 * Read a JSON file if it exists; return `null` on ENOENT. Throws on
 * bad JSON. Convenience wrapper for the `config/user.json`-is-optional
 * case.
 *
 * @param {string} file
 * @param {typeof import('node:fs/promises')} [fs]
 * @returns {Promise<Object|null>}
 */
export async function readJsonIfExists(file, fs = fsp) {
  if (typeof file !== 'string' || file.length === 0) return null;
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e && typeof e === 'object' && /** @type {any} */ (e).code === 'ENOENT') return null;
    throw e;
  }
  try {
    const v = JSON.parse(raw);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    return /** @type {Object} */ (v);
  } catch {
    return null;
  }
}

/**
 * Ensure the parent directory of `file` exists, recursively. No-op
 * if it already exists. Throws on permission errors. Convenience
 * wrapper around `mkdir(..., { recursive: true })`.
 *
 * @param {string} file
 * @param {typeof import('node:fs/promises')} [fs]
 * @returns {Promise<void>}
 */
export async function ensureParentDir(file, fs = fsp) {
  if (typeof file !== 'string' || file.length === 0) return;
  const dir = path.dirname(file);
  if (dir === '' || dir === '.' || dir === file) return;
  await fs.mkdir(dir, { recursive: true });
}

export const _internals = { pathExists, readJsonIfExists, ensureParentDir };