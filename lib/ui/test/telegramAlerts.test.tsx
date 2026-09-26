import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TelegramAlertsStrip } from '../src/console/TelegramAlertsStrip';
import { telegramAlertsViewV1 } from '../src/console/telegramAlertsView';

// The test runner compiles JSX with the classic transform: React.createElement.
void React;

const NOW = new Date('2026-09-26T10:00:00.000Z');
const URL = `https://t.me/miorailbot?start=${'A'.repeat(32)}`;
const base = { pending: null, busy: null, failed: null, now: NOW } as const;

describe('Alerts in Telegram, on the Stocks board', () => {
  test('nothing at all when there is no bot, or before the status is read', () => {
    assert.equal(telegramAlertsViewV1({ ...base, status: null }), null);
    assert.equal(telegramAlertsViewV1({ ...base, status: { available: false, linked: false } }), null);
  });

  test('not connected: what the bot sends, that it never asks for a signature, and one button', () => {
    const view = telegramAlertsViewV1({ ...base, status: { available: true, linked: false } })!;
    assert.equal(view.state, 'connect');
    assert.match(view.body, /a dividend paid in shares on a stock you hold/);
    assert.match(view.body, /never asks you to sign anything/);
    assert.deepEqual(view.action, { kind: 'connect', label: 'Connect Telegram', busy: false });
    assert.equal(view.link, null);
  });

  test('a link issued: the reader opens it with their own tap, until it lapses', () => {
    const pending = { url: URL, expiresAt: '2026-09-26T10:10:00.000Z' };
    const view = telegramAlertsViewV1({ ...base, status: { available: true, linked: false }, pending })!;
    assert.equal(view.state, 'open');
    assert.deepEqual(view.link, { href: URL, label: 'Open @miorailbot in Telegram' });
    assert.equal(view.action, null);
    assert.match(view.body, /works once, for ten minutes, and connects this wallet only/);

    const lapsed = telegramAlertsViewV1({ ...base, status: { available: true, linked: false }, pending, now: new Date('2026-09-26T10:10:00.000Z') })!;
    assert.equal(lapsed.state, 'connect');
    // A link that is not a t.me start link is never rendered.
    const odd = telegramAlertsViewV1({ ...base, status: { available: true, linked: false }, pending: { url: 'https://evil.example/start', expiresAt: pending.expiresAt } })!;
    assert.equal(odd.state, 'connect');
  });

  test('connected: what arrives and how to stop it; a failure is said in words', () => {
    const view = telegramAlertsViewV1({ ...base, status: { available: true, linked: true }, failed: 'disconnect', busy: 'disconnect' })!;
    assert.equal(view.state, 'linked');
    assert.equal(view.title, 'Telegram alerts are on');
    assert.match(view.body, /\/stop in the chat, or Disconnect here/);
    assert.deepEqual(view.action, { kind: 'disconnect', label: 'Disconnect', busy: true });
    assert.equal(view.error, 'Could not disconnect. Try again in a minute.');
  });

  test('the strip renders the link as a plain anchor, and the busy button disabled', () => {
    const noop = () => {};
    const open = telegramAlertsViewV1({ ...base, status: { available: true, linked: false }, pending: { url: URL, expiresAt: '2026-09-26T10:10:00.000Z' } })!;
    const html = renderToStaticMarkup(<TelegramAlertsStrip model={{ view: open, onConnect: noop, onDisconnect: noop }} />);
    assert.match(html, /<div class="mr-scope" aria-label="Telegram alerts">/);
    assert.match(html, new RegExp(`<a class="btn" href="${URL.replace(/[?]/g, '\\?')}" target="_blank" rel="noreferrer">Open @miorailbot in Telegram</a>`));
    assert.doesNotMatch(html, /<button/);

    const busy = telegramAlertsViewV1({ ...base, status: { available: true, linked: false }, busy: 'connect' })!;
    const busyHtml = renderToStaticMarkup(<TelegramAlertsStrip model={{ view: busy, onConnect: noop, onDisconnect: noop }} />);
    assert.match(busyHtml, /<button type="button" class="btn" disabled="">Connect Telegram…<\/button>/);
  });
});
