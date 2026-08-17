import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { createMemoryB20ProjectRepository, decodeFeedCursorV1 } from '@mioagent/route-storage';

import {
  DISCOVER_STANDING_SCAN_LIMIT_V1,
  b20RouteRuntime,
  readB20UniverseSummaryV1,
  readDiscoverFeedV1,
  resetB20SummaryCacheV1,
} from './b20Control.js';

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
    // A real 20-byte address. It was one nibble short, which nothing here had
    // ever validated — the project claim schema does, and caught it.
    tokenAddress: `0xb20000000000000000000000000000000000${suffix}`,
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
    getFeedRowForToken: async (input: { tokenAddress: string }) => {
      const row = rows.find(
        (entry) => entry.launch.tokenAddress.toLowerCase() === input.tokenAddress.toLowerCase(),
      );
      return row ? { row, history: [] } : null;
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

// ---------------------------------------------------------------------------
// The second axis: filters on measured evidence, not on the verdict.
//
// "Show me launches somebody bought and Miorail could not sell" is a verdict
// question and Stage 02 answered it. "Show me launches with at least ten
// buyers" and "show me launches whose round trip came in under 3%" are
// evidence questions, and the feed could not express either.
//
// The rule both of them share is the one worth pinning: an UNMEASURED value is
// excluded, never treated as zero. A round-trip bound that admitted unmeasured
// launches would return "cheaper than 3%" for tokens nobody priced.
// ---------------------------------------------------------------------------

describe('filters on measured evidence exclude what was never measured', () => {
  test('a buyer floor never admits a window that has not closed', async () => {
    const feed = await read({ minBuyers: 1, limit: 25 });
    for (const card of feed.cards) {
      const window = card.observation?.launchBuyerWindow ?? null;
      assert.equal(window?.status, 'measured', `${card.launch.symbol} was counted with an open window`);
      assert.ok((card.observation?.launchBuyers?.buyerCount ?? 0) >= 1);
    }
  });

  test('a buyer floor of zero still means "counted, and it was zero"', async () => {
    // Not the same as "no bound". A caller asking for zero is asking for
    // launches whose window closed with nobody in it.
    const feed = await read({ minBuyers: 0, limit: 25 });
    assert.ok(feed.cards.length > 0);
    for (const card of feed.cards) {
      assert.equal(card.observation?.launchBuyerWindow?.status, 'measured');
    }
  });

  test('a round-trip ceiling excludes an unmeasured round trip rather than reading it as free', async () => {
    const feed = await read({ maxRoundTripBps: 300, limit: 25 });
    for (const card of feed.cards) {
      const measured = card.observation?.optimisticRoundTripBps ?? null;
      assert.notEqual(measured, null, `${card.launch.symbol} has no measured round trip`);
      assert.ok(measured! <= 300);
    }
  });

  test('bothRoutes selects for evidence rather than against it', async () => {
    const feed = await read({ bothRoutes: true, limit: 25 });
    for (const card of feed.cards) {
      assert.equal(card.observation?.entryRouteFound, true);
      assert.equal(card.observation?.exitRouteFound, true);
    }
  });

  test('an exact conclusion is finer than its section', async () => {
    // `venue_not_searched` and `venue_not_found` share the miorail_limit
    // section and are different statements.
    const feed = await read({ standingKind: 'no_buyers_yet', limit: 25 });
    assert.ok(feed.cards.length > 0);
    for (const card of feed.cards) {
      assert.equal(card.observation?.standing.kind, 'no_buyers_yet');
    }
  });

  test('filters compose, and an impossible pair returns nothing rather than everything', async () => {
    // A silent drop is the dangerous failure: a caller who asked for the
    // impossible and got the whole feed reads every card as satisfying it.
    const feed = await read({ standingKind: 'no_buyers_yet', bothRoutes: true, limit: 25 });
    assert.deepEqual(feed.cards, []);
  });
});

describe('the universe is counted rather than paged', () => {
  test('the counts add up to the launches read', async () => {
    resetB20SummaryCacheV1();
    const summary = await readB20UniverseSummaryV1({ now: NOW });
    const standingTotal = summary.standing.reduce((sum, row) => sum + row.count, 0);
    const sectionTotal = summary.sections.reduce((sum, row) => sum + row.count, 0);
    const buyerTotal = summary.buyers.reduce((sum, row) => sum + row.count, 0);
    assert.equal(standingTotal, summary.window.launches);
    assert.equal(sectionTotal, summary.window.launches);
    assert.equal(buyerTotal, summary.window.launches);
    assert.ok(summary.window.launches > 25, 'a summary that only saw one page is a paged feed');
  });

  test('it counts the whole population, which one page cannot', async () => {
    resetB20SummaryCacheV1();
    const summary = await readB20UniverseSummaryV1({ now: NOW });
    const page = await read({ limit: 25 });
    const bought = summary.standing.find((row) => row.kind === 'bought_not_sellable')?.count ?? 0;
    const onPage = page.cards.filter((card) => card.observation?.standing.kind === 'bought_not_sellable').length;
    assert.ok(bought > onPage, `summary saw ${bought}, one page saw ${onPage}`);
  });

  test('every standing row carries the flag a reader must check before quoting it', async () => {
    resetB20SummaryCacheV1();
    const summary = await readB20UniverseSummaryV1({ now: NOW });
    for (const row of summary.standing) {
      assert.equal(typeof row.aboutToken, 'boolean');
      // The invariant the whole split rests on, asserted at the aggregate too.
      if (!row.aboutToken) assert.equal(row.group, 'miorail_limit');
    }
  });

  test('a venue set nobody recorded is null, never an invented name', async () => {
    resetB20SummaryCacheV1();
    const summary = await readB20UniverseSummaryV1({ now: NOW });
    for (const row of summary.venues) {
      assert.ok(row.venues === null || row.venues.length > 0);
    }
  });

  test('the answer says when it was computed and how long it may be reused', async () => {
    resetB20SummaryCacheV1();
    const summary = await readB20UniverseSummaryV1({ now: NOW });
    assert.equal(summary.computedAt, NOW.toISOString());
    assert.ok(summary.cachedForMs > 0);
    assert.ok(summary.caveats.length >= 3);
  });

  test('a cached answer is reused rather than re-read', async () => {
    resetB20SummaryCacheV1();
    await readB20UniverseSummaryV1({ now: NOW });
    listFeedCalls = 0;
    await readB20UniverseSummaryV1({ now: new Date(NOW.getTime() + 1_000) });
    assert.equal(listFeedCalls, 0, 'the summary re-read the corpus inside its own cache window');
  });

  test('a different window is a different question and is not served from cache', async () => {
    resetB20SummaryCacheV1();
    await readB20UniverseSummaryV1({ now: NOW });
    listFeedCalls = 0;
    await readB20UniverseSummaryV1({ now: NOW, maxLaunchAgeMs: 60 * 60 * 1000 });
    assert.ok(listFeedCalls > 0, 'a narrower window was answered with a wider window’s counts');
  });
});

// ---------------------------------------------------------------------------
// The project filter, and the order the two bounds are applied in.
//
// The bug: a page of `limit` CLAIMED tokens was gathered first and filtered by
// project standing afterwards. With thirty verified claims of which two are
// product-backed, that returned nothing at all — twenty-five cards were
// collected, none of them product-backed, and the filter emptied the page. A
// reader would have seen "no product-backed launches" and had no way to tell a
// short page from a short world.
//
// A bound applied to an unfiltered set is a bound on the wrong thing.
// ---------------------------------------------------------------------------

const CLAIM_COUNT = 30;

/** The two product-backed claims are the LAST two by address, so a read that
 * bounds before it filters cannot reach them. */
function claimedProjectsV1() {
  const repository = createMemoryB20ProjectRepository();
  const claimed: Promise<unknown>[] = [];
  for (let index = 0; index < CLAIM_COUNT; index += 1) {
    const tokenAddress = launch(index).tokenAddress;
    const productBacked = index >= CLAIM_COUNT - 2;
    claimed.push(
      repository.recordVerification({
        claim: {
          chainId: 8453,
          tokenAddress,
          claimantDomain: `p${index}.xyz`,
          status: 'verified',
          verifiedLinks: ['domain_file'],
          refutedLinks: [],
          lastCheckedAt: '2026-08-15T11:00:00.000Z',
        },
        evidence: [
          {
            chainId: 8453,
            tokenAddress,
            dimension: 'project_identity',
            state: 'verified',
            provenance: 'domain_claim_file',
            reference: `p${index}.xyz`,
            observedAt: '2026-08-15T11:00:00.000Z',
          },
          ...(productBacked
            ? ([
                {
                  chainId: 8453,
                  tokenAddress,
                  dimension: 'product',
                  state: 'live',
                  provenance: 'functional_probe',
                  reference: `https://p${index}.xyz/api`,
                  observedAt: '2026-08-15T11:00:00.000Z',
                },
              ] as const)
            : []),
        ],
      }),
    );
  }
  return Promise.all(claimed).then(() => repository);
}

describe('the project filter runs before the page bound', () => {
  const projectOriginal = {
    projects: b20RouteRuntime.projects,
    projectsAvailable: b20RouteRuntime.projectsAvailable,
  };

  before(async () => {
    const repository = await claimedProjectsV1();
    b20RouteRuntime.projects = () => repository;
    b20RouteRuntime.projectsAvailable = async () => true;
  });

  after(() => {
    b20RouteRuntime.projects = projectOriginal.projects;
    b20RouteRuntime.projectsAvailable = projectOriginal.projectsAvailable;
  });

  test('product-backed returns the product-backed launches, not an empty page', async () => {
    const feed = await read({ project: 'product_backed', limit: 25 });
    assert.equal(feed.cards.length, 2, 'the bound was applied before the filter again');
    for (const card of feed.cards) {
      assert.equal(card.project?.standing, 'product_backed');
    }
  });

  test('the wider filter includes them, because product-backed is verified plus one more thing', async () => {
    const feed = await read({ project: 'verified_project', limit: 25 });
    assert.equal(feed.cards.length, 25);
    for (const card of feed.cards) {
      assert.notEqual(card.project?.standing, 'unverified');
    }
  });

  test('every card in a filtered page carries the profile it was filtered on', async () => {
    // The filter reads one bulk profile lookup and the cards are built from the
    // same map, so a card cannot be selected by a profile it does not show.
    const feed = await read({ project: 'product_backed', limit: 25 });
    for (const card of feed.cards) {
      assert.ok(card.project?.identityVerified, 'a filtered card lost its profile');
      assert.ok(
        card.project?.findings.some((finding) => finding.dimension === 'product' && finding.state === 'live'),
        'a product-backed card carries no live product finding',
      );
    }
  });
});
