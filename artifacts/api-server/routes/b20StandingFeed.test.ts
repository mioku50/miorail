import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { decodeFeedCursorV1 } from '@mioagent/route-storage';

import { DISCOVER_STANDING_SCAN_LIMIT_V1, b20RouteRuntime, readDiscoverFeedV1 } from './b20Control.js';

// ---------------------------------------------------------------------------
// The verdict section is a SERVER filter, and this is why.
//
// Measured against the live 48-hour window on 2026-08-15, of 1,139 canonical
// launches only 70 were bought-and-unsellable. Ordered newest first, that is
// roughly one per page of 25 — so a client that fetched a page and grouped it
// would show a heading with one card under it and 46 pages of nothing between.
// The read has to scan.
//
// Two properties matter and neither is obvious:
//
//   * the section is decided by the SAME projection the screen groups with,
//     never by a SQL predicate — `bought_not_sellable`, `no_buyers_yet` and
//     `sale_unpriced` are separated by whether a buyer window closed and
//     whether it was counted, and a second implementation of that rule would
//     be a second answer to what a card means;
//
//   * the cursor points at the last row CONSUMED, not at the end of the page
//     being read. Rows after it were never examined, and returning the page's
//     own cursor would skip them.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-08-15T12:00:00.000Z');

function launch(index: number) {
  const suffix = index.toString(16).padStart(4, '0');
  return {
    id: `0x${'cd'.repeat(30)}${suffix}:0`,
    tokenAddress: `0xb2000000000000000000000000000000000${suffix}`,
    name: `T${index}`,
    symbol: `T${index}`,
    variant: 'asset' as const,
    decimals: 18,
    blockNumber: String(50_000_000 - index),
    transactionHash: `0x${'cd'.repeat(30)}${suffix}`,
    logIndex: 0,
    detectedAt: '2026-08-15T10:00:00.000Z',
    blockTimestamp: null,
    canonical: true,
  };
}

function observation(over: Record<string, unknown> = {}) {
  return {
    id: `0x${'ab'.repeat(32)}`,
    evidenceHash: `0x${'ef'.repeat(32)}`,
    state: 'rejected' as const,
    reasonCode: 'no_exit_route',
    referencePositionAtomic: '100000000',
    referenceQuoteAsset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    maxRoundTripBps: 300,
    maxExitSlippageBps: 300,
    entryRouteFound: true,
    exitRouteFound: false,
    entrySourceKey: 'uniswap-v4:pool',
    exitSourceKey: null,
    poolHookAddress: null,
    optimisticExitReturnAtomic: null,
    optimisticRoundTripBps: null,
    routeCoverage: 'complete' as const,
    viableRouteConfirmed: false,
    bestRouteConfirmed: false,
    largestPassingSizeAtomic: null,
    firstFailingSizeAtomic: null,
    capacityToleranceBps: 300,
    capacityProbeCount: 0,
    capacityStable: null,
    transfersPaused: false,
    transferPolicyState: 'open' as const,
    controlsComplete: true,
    controlsBlockNumber: '50000028',
    observationBlockNumber: '50000028',
    quoteAlignment: 'anchored' as const,
    measuredAt: '2026-08-15T11:50:00.000Z',
    staleAfter: '2026-08-15T12:20:00.000Z',
    ...over,
  };
}

/** A closed, counted buyer window. Null buyers means the window is still open,
 * which is a different card entirely. */
function buyers(count: number, launchBlock: string) {
  return {
    buyerCount: count,
    topBuyerShareBps: 1_200,
    topThreeShareBps: 3_000,
    fromBlock: launchBlock,
    toBlock: String(Number(launchBlock) + 10_000),
  };
}

type Row = { launch: ReturnType<typeof launch>; observation: unknown; launchBuyers: unknown };

/**
 * The live shape, at one-hundredth scale: 100 launches in which 6 were bought
 * and could not be sold, mixed among launches nobody bought and launches
 * Miorail never found a venue for.
 */
function population(): Row[] {
  return Array.from({ length: 100 }, (_, index) => {
    const l = launch(index);
    if (index % 17 === 3) {
      return { launch: l, observation: observation(), launchBuyers: buyers(62, l.blockNumber) };
    }
    if (index % 3 === 0) {
      return {
        launch: l,
        observation: observation({ reasonCode: 'no_entry_route', entryRouteFound: false }),
        launchBuyers: buyers(0, l.blockNumber),
      };
    }
    return { launch: l, observation: observation(), launchBuyers: buyers(0, l.blockNumber) };
  });
}

let listFeedCalls = 0;

/** A cursor-honouring stub. The real repository pages by (block, measuredAt,
 * launch id); this one pages by position, which is the same contract at this
 * scale and keeps the test about the scan rather than about SQL ordering. */
function stubObservations(rows: Row[]) {
  return {
    listFeed: async (input: { limit: number; cursor: string | null }) => {
      listFeedCalls += 1;
      const start = input.cursor
        ? rows.findIndex((row) => row.launch.id === decodeFeedCursorV1(input.cursor!)?.launchId) + 1
        : 0;
      const page = rows.slice(start, start + input.limit);
      const nextIndex = start + page.length;
      return {
        rows: page,
        nextCursor:
          nextIndex < rows.length && page.length > 0
            ? Buffer.from(
                [page[page.length - 1]!.launch.blockNumber, '', page[page.length - 1]!.launch.id].join(' '),
                'utf8',
              ).toString('base64url')
            : null,
      };
    },
    pipelineCounts: async () => ({
      ingestionCursorBlock: '50000000',
      lastIngestionConfirmedHead: '50000010',
      lastIngestionRunAt: '2026-08-15T11:55:00.000Z',
      lastIngestionResult: 'success',
      lastMeasurementRunAt: '2026-08-15T11:50:00.000Z',
      canonicalLaunchCount: rows.length,
      launchesAwaitingMeasurement: 0,
      observationCount: rows.length,
      lastIngestionBudgetExhausted: false,
      ingestionOperatorState: null,
    }),
  } as never;
}

const original = {
  observations: b20RouteRuntime.observations,
  discoverAvailable: b20RouteRuntime.discoverAvailable,
  now: b20RouteRuntime.now,
};

before(() => {
  b20RouteRuntime.observations = () => stubObservations(population());
  b20RouteRuntime.discoverAvailable = async () => true;
  b20RouteRuntime.now = () => NOW;
});

after(() => {
  b20RouteRuntime.observations = original.observations;
  b20RouteRuntime.discoverAvailable = original.discoverAvailable;
  b20RouteRuntime.now = original.now;
});

const read = (over: Partial<Parameters<typeof readDiscoverFeedV1>[0]> = {}) =>
  readDiscoverFeedV1({ limit: 25, cursor: null, state: 'all', freshness: 'all', ...over });

describe('a verdict section is filled by scanning, not by taking one page', () => {
  test('the unfiltered feed still reads exactly one page', async () => {
    listFeedCalls = 0;
    const feed = await read();
    assert.equal(feed.cards.length, 25);
    assert.equal(listFeedCalls, 1, 'the default feed must not have become a multi-page scan');
  });

  test('one page of the unfiltered feed holds almost none of the finding', async () => {
    // The measurement this whole change rests on. Grouping client-side would
    // have produced a heading with one card under it.
    const feed = await read();
    const bought = feed.cards.filter((card) => card.observation?.standing.kind === 'bought_not_sellable');
    assert.ok(bought.length <= 2, `expected the finding to be sparse, found ${bought.length} in 25`);
  });

  test('the filtered read returns only that section, gathered across pages', async () => {
    const feed = await read({ standing: 'bought_not_sellable' });
    assert.ok(feed.cards.length >= 5, `expected the whole section, got ${feed.cards.length}`);
    for (const card of feed.cards) {
      assert.equal(card.observation?.standing.kind, 'bought_not_sellable');
      assert.equal(card.observation?.standing.aboutToken, true);
    }
  });

  test('a section that fits entirely in the window reports no next page', async () => {
    const feed = await read({ standing: 'bought_not_sellable' });
    assert.equal(feed.nextCursor, null);
  });

  test('Miorail’s own limits are a section, and nothing in it claims to be about a token', async () => {
    const feed = await read({ standing: 'miorail_limit' });
    assert.ok(feed.cards.length > 0);
    for (const card of feed.cards) {
      assert.equal(card.observation?.standing.aboutToken, false);
    }
  });

  test('a full page hands back a cursor pointing at the last row it consumed', async () => {
    // Not the cursor of the page it happened to be reading: rows after the last
    // match were never examined, and skipping them would drop cards silently.
    const first = await read({ standing: 'no_buyers_yet', limit: 5 });
    assert.equal(first.cards.length, 5);
    assert.ok(first.nextCursor, 'a section with more to give must say so');

    const decoded = decodeFeedCursorV1(first.nextCursor!);
    const lastToken = first.cards[first.cards.length - 1]!.launch.tokenAddress;
    assert.ok(decoded, 'the cursor must be readable by the repository that issued it');
    assert.ok(decoded!.launchId.startsWith('0x'), 'the cursor carries a launch id');

    const second = await read({ standing: 'no_buyers_yet', limit: 5, cursor: first.nextCursor });
    const seen = new Set(first.cards.map((card) => card.launch.tokenAddress));
    for (const card of second.cards) {
      assert.ok(!seen.has(card.launch.tokenAddress), `${card.launch.symbol} was returned on both pages`);
    }
    assert.notEqual(second.cards[0]?.launch.tokenAddress, lastToken);
  });

  test('the scan is bounded, so one filtered page cannot walk the whole table', async () => {
    assert.equal(DISCOVER_STANDING_SCAN_LIMIT_V1, 1_200);
    listFeedCalls = 0;
    // A section nothing in this population belongs to: the scan runs to the end
    // of the data and stops, rather than looping.
    const feed = await read({ standing: 'two_sided' });
    assert.deepEqual(feed.cards, []);
    assert.equal(feed.nextCursor, null);
    assert.ok(listFeedCalls <= DISCOVER_STANDING_SCAN_LIMIT_V1 / 100 + 1, `scan made ${listFeedCalls} reads`);
  });

  test('an unavailable Discover returns the pipeline sentence, not an empty section', async () => {
    b20RouteRuntime.discoverAvailable = async () => false;
    try {
      const feed = await read({ standing: 'bought_not_sellable' });
      assert.deepEqual(feed.cards, []);
      assert.ok(feed.pipeline.message.length > 0);
    } finally {
      b20RouteRuntime.discoverAvailable = async () => true;
    }
  });
});
