import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { MarketRealityRadarScreen } from '../src/console/MarketRealityRadarScreen';
import {
  marketRealityRadarViewV1,
  type MarketRealityRadarEventWireV1,
  type MarketRealityRadarWatchWireV1,
} from '../src/console/marketRealityRadarView';

const ADDRESS = '0xb20000000000000000000078ee7ce2fe4908108c';
const HASH_A = `0x${'11'.repeat(32)}`;
const HASH_B = `0x${'22'.repeat(32)}`;
const WATCH_ID = `0x${'33'.repeat(32)}`;
const NOW = '2026-08-28T08:00:00.000Z';

function watch(
  over: Partial<MarketRealityRadarWatchWireV1> = {},
): MarketRealityRadarWatchWireV1 {
  return {
    watchId: WATCH_ID,
    chainId: 8453,
    underlyingKey: 'isin:us:US67066G1040',
    tokenAddress: ADDRESS,
    issuerId: 'coinbase',
    representationKind: 'b20_asset',
    direction: 'sell',
    requestedCashAtomic: '1000000000',
    destination: 'USDC',
    routePolicyKey: `0x${'44'.repeat(32)}`,
    approvedSources: ['coinbase_trade_api'],
    createdAt: '2026-08-28T06:00:00.000Z',
    lastEvaluatedAt: '2026-08-28T07:30:00.000Z',
    lastComparableAt: '2026-08-28T07:30:00.000Z',
    lastEvaluationOutcome: 'compared',
    ...over,
  };
}

function event(
  over: Partial<MarketRealityRadarEventWireV1> = {},
): MarketRealityRadarEventWireV1 {
  return {
    eventId: `0x${'55'.repeat(32)}`,
    watchId: WATCH_ID,
    chainId: 8453,
    tokenAddress: ADDRESS,
    kind: 'sell_exit_cost_changed',
    previousSnapshotHash: HASH_A,
    snapshotHash: HASH_B,
    previousObservedAt: '2026-08-28T07:00:00.000Z',
    occurredAt: '2026-08-28T07:30:00.000Z',
    approvedSources: ['coinbase_trade_api'],
    facts: {
      previousCashBackAtomic: '997300000',
      cashBackAtomic: '995800000',
      cashBackChangeAtomic: '-1500000',
      previousExitCostBps: '27',
      exitCostBps: '42',
      changeBps: '15',
    },
    ...over,
  };
}

function project(input: {
  watches?: MarketRealityRadarWatchWireV1[];
  events?: MarketRealityRadarEventWireV1[];
}) {
  return marketRealityRadarViewV1({
    wire: {
      watches: input.watches ?? [watch()],
      events: input.events ?? [event()],
      assembledAt: NOW,
    },
    choices: [
      {
        underlyingKey: 'isin:us:US67066G1040',
        title: 'NVIDIA (NVDA)',
        identifier: 'ISIN US67066G1040',
        issuerLine: 'Coinbase only',
        issuerIds: ['coinbase'],
        representationCount: 1,
        multiIssuer: false,
      emptyNote: null,
      },
    ],
    now: NOW,
  })!;
}

describe('Phase 12.2 Radar presentation preserves evidence boundaries', () => {
  test('a +15 bps change is factual and receives no good/bad tone', () => {
    const view = project({});
    assert.equal(view.events[0]?.headline, 'Exit cost widened');
    assert.equal(view.events[0]?.delta, '−$1.50 · +15 bps');
    const html = renderToStaticMarkup(
      <MarketRealityRadarScreen
        model={{
          view,
          loading: false,
          error: null,
          removingWatchId: null,
          onRemove: () => undefined,
          onOpenMarket: () => undefined,
        }}
      />,
    );
    assert.match(html, /Exit cost widened/);
    assert.doesNotMatch(html, /data-tone="(?:good|bad)"/);
  });

  test('a provider failure is a technical gap and never an asset event', () => {
    const view = project({
      watches: [watch({ lastEvaluationOutcome: 'measurement_failed' })],
      events: [],
    });
    assert.equal(view.events.length, 0);
    assert.match(view.watches[0]?.statusNote ?? '', /no event was created/i);
    assert.match(view.watches[0]?.technicalOutcome ?? '', /our latest read failed/i);
  });

  test('the exact comparable snapshot pair and route policy remain reachable', () => {
    const view = project({});
    assert.equal(view.events[0]?.previousSnapshotHash, HASH_A);
    assert.equal(view.events[0]?.snapshotHash, HASH_B);
    assert.match(view.watches[0]?.routePolicyKey ?? '', /^0x[0-9a-f]{64}$/);
    assert.equal(view.watches[0]?.approvedSources, 'coinbase_trade_api');
  });

  test('reviewed session enums become human primary copy', () => {
    const view = project({
      events: [
        event({
          kind: 'market_session_changed',
          facts: {
            previousMarketSession: 'regular_hours',
            marketSession: 'after_hours',
            previousPublicationMode: 'live_reference',
            publicationMode: 'holding_last_close',
          },
        }),
      ],
    });
    assert.equal(view.events[0]?.primary, 'US market open → US market closed / after hours');
    assert.equal(
      view.events[0]?.secondary,
      'Live reference publication → Reference holding last published value',
    );
    assert.doesNotMatch(view.events[0]?.primary ?? '', /regular_hours|after_hours/);
    assert.match(view.events[0]?.technicalFacts ?? '', /regular_hours/);
    assert.equal(view.events[0]?.technicalKind, 'market_session_changed');
  });
});
