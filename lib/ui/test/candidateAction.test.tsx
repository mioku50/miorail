import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { RouteScreen, type RouteScreenModelV1 } from '../src/console/ConsoleScreens';

void React;

// ---------------------------------------------------------------------------
// A control that looks live and does nothing is worse than one that is off.
//
// A real "Swap 1 USDC to ETH" run in production reached the route card with
// one quotable candidate, and both ways forward were dead: "Review
// Transaction" was wired to `recommended && review(...)` while a
// single-provider run produces no recommendation, and "Use this" called
// `onSelect?.(id)` through optional chaining. Neither said anything. The
// stepper sat on `Review —` and there was no way to tell a refused click
// from an unregistered one.
//
// These pin the two properties that make that impossible: a rendered button
// must be able to act, and a button that cannot act must say why.
// ---------------------------------------------------------------------------

const CANDIDATE_HASH = `0x${'ab'.repeat(32)}`;

function model(overrides: Partial<RouteScreenModelV1> = {}): RouteScreenModelV1 {
  return {
    steps: [],
    eyebrow: 'Route card',
    amount: '1',
    unit: 'USDC',
    usd: '$1.00',
    providerLabel: 'no provider',
    freshness: { label: 'quote age unknown', tone: 'a' },
    why: 'Single route available · no comparative recommendation',
    kpis: [],
    graph: null,
    graphUnavailableReason: 'no pool breakdown',
    graphLegend: [],
    simulatedPill: { label: 'not simulated yet', tone: 'n' },
    scoreRows: [],
    scoringVersion: 'swap-path-score/v1',
    providerHistory: [],
    candidates: [
      {
        id: CANDIDATE_HASH,
        name: 'Aerodrome',
        outputLabel: '0.000519986088141452',
        netLabel: '0.000517386157700744',
        scorePercent: 0,
        scoreDim: true,
        why: 'Alternative route · 2 calls, 1 approval',
        state: 'available',
        stateLabel: 'available',
        actionLabel: 'Unavailable',
        selectable: true,
      },
    ],
    onReview: () => {},
    onSelectCandidate: () => {},
    reviewDisabledReason: null,
    tokenPanels: [],
    diagnostics: [],
    claimHeadline: null,
    onCompareAgain: () => {},
    comparePending: false,
    onChangeGoal: () => {},
    ...overrides,
  } as RouteScreenModelV1;
}

describe('the route card never renders a button that cannot act', () => {
  test('"Use this" renders enabled when a handler exists', () => {
    const html = renderToStaticMarkup(<RouteScreen {...model()} />);
    assert.match(html, /Use this/);
    // Not disabled — the row is genuinely actionable.
    assert.ok(!/disabled[^>]*>Use this/.test(html), 'a live handler must not render a disabled button');
  });

  test('with no handler, the row falls back to its state instead of a dead button', () => {
    // This is the regression. Optional chaining used to render "Use this"
    // here, fully enabled, silently discarding every click.
    const html = renderToStaticMarkup(
      <RouteScreen {...model({ onSelectCandidate: undefined as unknown as (id: string) => void })} />,
    );
    assert.ok(!/>Use this</.test(html), 'a handler-less row must not offer "Use this"');
  });

  test('a blocked review states its reason rather than presenting a live button', () => {
    const reason = 'This comparison finished without a signable Route Card, so there is nothing to review.';
    const html = renderToStaticMarkup(<RouteScreen {...model({ reviewDisabledReason: reason })} />);
    assert.match(html, /disabled/, 'the review button is off');
    assert.ok(html.includes(reason), 'and the screen says why');
  });

  test('the reason is shown before the click, not after it', () => {
    // The whole point: a user must not have to click a dead control to learn
    // that it is dead.
    const reason = 'No provider returned a quotable route for this goal.';
    const html = renderToStaticMarkup(<RouteScreen {...model({ reviewDisabledReason: reason })} />);
    assert.ok(html.indexOf(reason) > 0);
  });
});
