// dashboard/src/components/ErrorState.jsx
//
// Tiny "couldn't load" placeholder. Used by every view when the
// underlying API call failed — keeps the failure messaging
// consistent.

import React from 'react';

export default function ErrorState(props) {
  const message = props.message || 'Could not load data.';
  return (
    <div className="rounded-md border border-amber-700/60 bg-amber-950/30 p-4 text-sm text-amber-200">
      <div className="font-mono uppercase tracking-wider text-xs text-amber-300">error</div>
      <div className="mt-1">{message}</div>
      {props.onRetry && (
        <button
          type="button"
          onClick={props.onRetry}
          className="mt-2 rounded border border-amber-700/60 px-3 py-1 text-xs font-mono uppercase tracking-wider text-amber-200 hover:bg-amber-900/40"
        >
          retry
        </button>
      )}
    </div>
  );
}