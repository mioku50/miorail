import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  b20ClaimStandingV1,
  b20FundamentalProfileV1,
  type B20FundamentalProfileV1,
} from '@mioagent/opportunity-rail';
import { OpportunitiesScreen, type OpportunityCardViewV1 } from '../src/console/OpportunitiesScreen';
import { opportunityCardViewV1 } from '../src/console/opportunityCardView';

void React;

// ---------------------------------------------------------------------------
// Project context on a card.
//
// The failure this whole layer exists to prevent is one project's record
// appearing under another token's name, so the tests that matter are the ones
// where a profile must NOT be rendered.
// ---------------------------------------------------------------------------

const NOW = '2026-08-16T12:00:00.000Z';

const PRODUCT_BACKED = b20FundamentalProfileV1({
  claim: b20ClaimStandingV1({
    claimantDomain: 'miorail.xyz',
    status: 'verified',
    verifiedLinks: ['domain_file'],
    refutedLinks: [],
    lastCheckedAt: NOW,
  }),
  claimantDomain: 'miorail.xyz',
  website: { url: 'https://miorail.xyz', reachable: true, observedAt: NOW },
  product: { url: 'https://miorail.xyz/mcp', reachable: true, functional: true, observedAt: NOW },
  docs: null,
  repository: null,
  basePresence: { kind: 'mcp_endpoint', reference: 'https://miorail.xyz/mcp', observedAt: NOW },
  launchedAt: null,
  now: NOW,
});

const UNVERIFIED = b20FundamentalProfileV1({
  claim: b20ClaimStandingV1(null),
  claimantDomain: null,
  website: null,
  product: null,
  docs: null,
  repository: null,
  basePresence: null,
  launchedAt: null,
  now: NOW,
});

function wireCard(project: B20FundamentalProfileV1 | null | undefined) {
  return {
    launch: {
      tokenAddress: '0xb200000000000000000000578f3ae29d9e6e0101',
      name: 'Miorail',
      symbol: 'MIO',
      variant: 'asset' as const,
      decimals: 18,
      blockNumber: '48661648',
      ageSeconds: null,
      launchTimeSource: 'discovered' as const,
      canonical: true,
    },
    observation: null,
    ...(project === undefined ? {} : { project }),
    canCheckProfile: false,
    action: { action: 'none' as const, label: null, reason: 'Nothing has been measured yet.' },
    notMeasured: [],
  };
}

function render(cards: OpportunityCardViewV1[]): string {
  return renderToStaticMarkup(
    <OpportunitiesScreen
      pipelineNotice={null}
      pipelineState="healthy"
      feedRenderable
      cards={cards}
      filter="all"
      freshOnly={false}
      loading={false}
      onFilterChange={() => undefined}
      onFreshOnlyChange={() => undefined}
      onOpenToken={() => undefined}
    />,
  );
}

describe('a verified project reads as project context, never as a measurement', () => {
  const markup = render([opportunityCardViewV1(wireCard(PRODUCT_BACKED))]);

  test('the domain and the standing lead the block', () => {
    assert.match(markup, /miorail\.xyz/);
    assert.match(markup, /Product-backed · Project link verified/);
  });

  test('the collapsed block shows what was established, not how', () => {
    assert.match(markup, /Product<\/dt><dd><strong>Live/);
    assert.match(markup, /Base presence<\/dt><dd><strong>Verified/);
  });

  test('every state carries its provenance and its time in the evidence fold', () => {
    assert.match(markup, /View evidence/);
    assert.match(markup, /functional probe/);
    assert.match(markup, /https_probe|https probe/);
    assert.match(markup, /2026-08-16 12:00 UTC/);
  });

  test('what was NOT established is named, not omitted', () => {
    assert.match(markup, /Not established:/);
    assert.match(markup, /repository/i);
    assert.match(markup, /before token/i);
  });

  test('the block refuses to be read as a review or a rating', () => {
    assert.match(markup, /not a review, not a rating and not a statement about price/i);
    for (const banned of ['promising', 'bullish', 'good buy', 'high potential', 'invest', 'undervalued']) {
      assert.ok(!new RegExp(banned, 'i').test(markup), `the card says "${banned}"`);
    }
  });

  test('project context is not mixed into the measurement evidence', () => {
    // Two different questions from two different kinds of evidence. A reader
    // who sees them in one list will read a verified project as a measured
    // exit, or the reverse.
    const projectAt = markup.indexOf('project-context');
    const measuredAt = markup.indexOf('What was measured');
    assert.ok(projectAt > 0, 'no project block was rendered');
    assert.ok(measuredAt === -1 || projectAt < measuredAt);
  });
});

describe('an unverified project is one quiet line, and a missing layer is silence', () => {
  test('the verdict stays on the card and the explanation folds away', () => {
    const markup = render([opportunityCardViewV1(wireCard(UNVERIFIED))]);
    // Unverified is the ORDINARY case, so this text appeared in full on nearly
    // every card in the feed — forty words of caveat repeated down the page,
    // which is how a careful sentence becomes something a reader skips. The
    // verdict is still stated; only the paragraph moved behind a disclosure,
    // the same treatment the verified branch already used.
    assert.match(markup, /<summary>Project context — Unverified<\/summary>/);
    assert.match(markup, /most launches are never claimed/i);
    // Closed until asked for: `<details>` without `open`.
    assert.ok(!/<details[^>]*\bopen\b[^>]*class="card-evidence project-unverified"/.test(markup));
    // Still no facts and no control — a column of unknowns invites a reader to
    // wonder what would fill it in.
    assert.ok(!/project-context/.test(markup));
    assert.ok(!/View evidence/.test(markup));
  });

  test('a server that does not run the layer says nothing at all', () => {
    // `project: null` is NOT "nobody claimed it" — one is about this server and
    // the other is about the token, and only the second belongs on a card.
    const markup = render([opportunityCardViewV1(wireCard(null))]);
    assert.ok(!/Project context/.test(markup));
    assert.ok(!/project-unverified/.test(markup));
  });

  test('a card from a server that predates the layer renders exactly as before', () => {
    const markup = render([opportunityCardViewV1(wireCard(undefined))]);
    assert.ok(!/Project context/.test(markup));
    assert.match(markup, /MIO/);
  });
});

describe('the copycat case, at the surface', () => {
  test('a token with no claim shows no other project’s domain, product or repository', () => {
    // The impostor arrives as a card with a real symbol and no claim. Nothing
    // from a verified project may appear on it.
    const markup = render([
      opportunityCardViewV1({
        ...wireCard(UNVERIFIED),
        launch: { ...wireCard(UNVERIFIED).launch, tokenAddress: '0xb200000000000000000000000000000000000bad' },
      }),
    ]);
    for (const leak of ['miorail.xyz', 'github.com', '/mcp', 'Product-backed']) {
      assert.ok(!markup.includes(leak), `an unclaimed card leaked "${leak}"`);
    }
  });
});

describe('the project filter is offered only when a host wired it', () => {
  test('the three buckets are named, and unknown is worded as a state', () => {
    const markup = renderToStaticMarkup(
      <OpportunitiesScreen
        pipelineNotice={null}
        pipelineState="healthy"
        feedRenderable
        cards={[]}
        filter="all"
        projectFilter="all"
        onProjectFilterChange={() => undefined}
        freshOnly={false}
        loading={false}
        onFilterChange={() => undefined}
        onFreshOnlyChange={() => undefined}
        onOpenToken={() => undefined}
      />,
    );
    assert.match(markup, /Project-backed/);
    assert.match(markup, /Verified project/);
    assert.match(markup, /Project context unknown/);
    // Not "no project", not "unclaimed", not anything that reads as a failure.
    assert.ok(!/no project/i.test(markup));
  });
});
