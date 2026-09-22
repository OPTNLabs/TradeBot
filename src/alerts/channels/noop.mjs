#!/usr/bin/env node
// src/alerts/channels/noop.mjs
//
// T53.1 — noop channel adapter.
//
// The "I just want to test the router shape" channel: accepts every
// event, returns synchronously, throws never. Used by every unit
// test that exercises the router so the test stays deterministic
// regardless of which platform features are available.
//
// Tests can introspect the channel's `sent` array to assert which
// events were "delivered" without leaking test state into the
// router's redacted-exports surface.

/**
 * @typedef {import('../router.mjs').AlertChannel} AlertChannel
 * @typedef {import('../router.mjs').AlertEvent} AlertEvent
 */

/**
 * Construct a noop channel. Records every accepted event in the
 * returned object's `sent` array (handy for assertions in tests).
 *
 * @param {{min_severity?: import('../router.mjs').AlertSeverity, id?: string}} [opts]
 * @returns {AlertChannel & {sent: AlertEvent[]}}
 */
export function createNoopChannel(opts = {}) {
  /** @type {AlertEvent[]} */
  const sent = [];
  const id = (opts && typeof opts.id === 'string') ? opts.id : 'noop';
  const min_severity = (opts && typeof opts.min_severity === 'string') ? opts.min_severity : 'info';
  return Object.freeze({
    id,
    displayName: 'No-op',
    min_severity,
    isReady: () => true,
    send: async (_channel, event) => {
      sent.push(event);
    },
    sent,
  });
}
