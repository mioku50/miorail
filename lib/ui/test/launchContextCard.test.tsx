import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  B20LaunchContextCard,
  type B20LaunchContextModelV1,
  type B20LaunchContextViewV1,
} from '../src/console/B20LaunchContextCard';

void React;

// ---------------------------------------------------------------------------
// Launch Context on screen.
//
// Two things this card must never do, and both are one keystroke away:
// render a count for a launch whose sender is a bundler, and render "0 of 3"
// as if it were a grade.
// ---------------------------------------------------------------------------

const TOKEN = '0xb200000000000000000000195a5f43905160ee01';
const SENDER = '0x07431d0db9042f8be2368bbff98d2879b4e665ab';

const contextV1 = (over: Partial<B20LaunchContextViewV1> = {}): B20LaunchContextViewV1 => ({
  schemaVersion: 'b20-launch-context/v1',
  tokenAddress: TOKEN,
  headline: 'Sent straight to the B20 factory.',
  reading: { status: 'read', deployerAddress: SENDER, relation: 'direct', readAt: '2026-08-16T00:00:00.000Z' },
  corpus: { launchCount: 3, standingCounts: [], coverage: { launchesRead: 300, launchesTotal: 5909 } },
  claim: {
    status: 'no_claim',
    headline: 'Unverified context.',
    detail: 'No project has claimed this token to Miorail.',
    verifiedLinks: [],
    refutedLinks: [],
    uncheckedLinks: ['launch_sender', 'domain_file', 'project_publication'],
    verifiedLabel: '0 of 3',
  },
  caveats: ['The launch sender is an address. It is not a team, a company or a reputation.'],
  serverTime: '2026-08-16T00:00:00.000Z',
  ...over,
});

const model = (over: Partial<B20LaunchContextModelV1> = {}): B20LaunchContextModelV1 => ({
  tokenAddress: TOKEN,
  loading: false,
  context: contextV1(),
  error: null,
  onOpen: () => {},
  ...over,
});

const render = (over: Partial<B20LaunchContextModelV1> = {}) =>
  renderToStaticMarkup(<B20LaunchContextCard tokenAddress={TOKEN} model={model(over)} />);

describe('the card renders only what the server sent', () => {
  test('a direct launch shows the sender and its count', () => {
    const html = render();
    assert.match(html, /Sent straight to the B20 factory/);
    assert.match(html, /0x07431d0d…b4e665ab/);
    assert.match(html, /Launches from this address/);
  });

  test('a relayed launch shows no count, because the server sent none', () => {
    // There is no branch in this component that can produce a count from a
    // null corpus — the refusal lives in the data, not in a condition here.
    const html = render({
      context: contextV1({
        headline: 'Relayed through the ERC-4337 EntryPoint.',
        reading: { status: 'read', deployerAddress: SENDER, relation: 'bundler', readAt: '2026-08-16T00:00:00.000Z' },
        corpus: null,
      }),
    });
    assert.doesNotMatch(html, /Launches from this address/);
    assert.match(html, /Relayed through the ERC-4337 EntryPoint/);
  });

  test('an unread launch says so instead of showing an empty row', () => {
    const html = render({
      context: contextV1({
        headline: 'Miorail has not read this launch’s transaction.',
        reading: { status: 'not_read' },
        corpus: null,
      }),
    });
    assert.match(html, /has not read this launch’s transaction/);
    assert.doesNotMatch(html, /Sent by/);
  });
});

describe('identity is a checklist, never a grade', () => {
  test('every link is listed with what happened to it', () => {
    const html = render();
    for (const label of ['Launch sender', 'File on the project’s domain', 'Published by the project']) {
      assert.ok(html.includes(label), `${label} missing`);
    }
    assert.match(html, /not checked/);
    assert.match(html, /0 of 3/);
  });

  test('a verified link reads as verified and the rest stay unchecked', () => {
    const html = render({
      context: contextV1({
        claim: {
          status: 'verified',
          headline: 'Claimed by example.org.',
          detail: 'One check links this token to example.org.',
          verifiedLinks: ['launch_sender'],
          refutedLinks: [],
          uncheckedLinks: ['domain_file', 'project_publication'],
          verifiedLabel: '1 of 3',
        },
      }),
    });
    assert.match(html, /Launch sender — verified/);
    assert.match(html, /1 of 3/);
  });

  test('nothing on this card is a percentage or a rating', () => {
    const html = render();
    assert.doesNotMatch(html, /\bscore\b|\brating\b|\bgrade\b/i);
  });
});

describe('the card is closed until it is asked for', () => {
  test('it renders as a details element, not an always-open panel', () => {
    const html = render();
    assert.match(html, /^<details/);
    assert.doesNotMatch(html, /<details open/);
  });

  test('a card for another token shows nothing of this one', () => {
    const html = renderToStaticMarkup(
      <B20LaunchContextCard tokenAddress="0xother" model={model()} />,
    );
    assert.doesNotMatch(html, /0x07431d0d/);
  });
});
