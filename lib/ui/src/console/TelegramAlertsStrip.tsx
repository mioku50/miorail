'use client';

import React from 'react';

import type { TelegramAlertsViewV1 } from './telegramAlertsView';

// The test runner compiles JSX with the classic transform: React.createElement.
void React;

export interface TelegramAlertsModelV1 {
  view: TelegramAlertsViewV1;
  onConnect: () => void;
  onDisconnect: () => void;
}

/** The same strip the visitor notice uses: a title, a sentence, one control. */
export function TelegramAlertsStrip({ model }: { model: TelegramAlertsModelV1 }) {
  const { view } = model;
  return (
    <div className="mr-scope" aria-label="Telegram alerts">
      <div>
        <h3>{view.title}</h3>
        <p className="lnote">{view.body}</p>
        {view.error ? (
          <p className="lnote" role="status">
            {view.error}
          </p>
        ) : null}
      </div>
      {view.link ? (
        <a className="btn" href={view.link.href} target="_blank" rel="noreferrer">
          {view.link.label}
        </a>
      ) : null}
      {view.action ? (
        <button
          type="button"
          className={view.action.kind === 'disconnect' ? 'btn sec' : 'btn'}
          disabled={view.action.busy}
          onClick={view.action.kind === 'disconnect' ? model.onDisconnect : model.onConnect}
        >
          {view.action.busy ? `${view.action.label}…` : view.action.label}
        </button>
      ) : null}
    </div>
  );
}
