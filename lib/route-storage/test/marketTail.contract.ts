import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  type MarketTailRepositoryV1,
  type MarketVenueTransferRowV1,
  type MarketVenueRowV1,
} from '../src/marketTail.js';

const AAPL = '0xb200000000000000000000c2e324d24d7eecd1fb';
const NVDA = '0xb20000000000000000000078ee7ce2fe4908108c';
const POOL = '0xa3b1e3f9747065e2073722ff4c9027d3ea4994f0';
const SINGLETON = '0x498581ff718922c3f8e6a244956af099b2652b2b';
const ROUTER = '0x4ee35c658b8032a7577096b60bd51ae9909e4f98';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WALLET = '0x1111111111111111111111111111111111111111';
const TAIL = 'official_asset_ledger';

function venueFixtureV1(overrides: Partial<MarketVenueRowV1> = {}): MarketVenueRowV1 {
  return {
    chainId: 8453,
    address: POOL,
    kind: 'paired_pool',
    token0: USDC,
    token1: AAPL,
    firstSeenAt: '2026-08-25T09:00:00.000Z',
    identifiedAt: '2026-08-25T09:00:00.000Z',
    ...overrides,
  } as MarketVenueRowV1;
}

function eventFixtureV1(overrides: Partial<MarketVenueTransferRowV1> = {}): MarketVenueTransferRowV1 {
  return {
    chainId: 8453,
    tokenAddress: AAPL,
    venueAddress: POOL,
    direction: 'out_of_venue',
    counterparty: WALLET,
    amountAtomic: '322751470',
    blockNumber: 50_428_000,
    transactionHash: `0x${'ab'.repeat(32)}`,
    logIndex: 7,
    observedAt: '2026-08-25T09:00:00.000Z',
    ...overrides,
  } as MarketVenueTransferRowV1;
}

/**
 * The contract both repositories are held to.
 *
 * Each case is a route by which the tail could publish something it did not
 * observe: a movement through an address nobody identified, the same log counted
 * twice, a cursor that rewinds and re-scans while looking healthy.
 */
export function marketTailContractV1(
  label: string,
  open: () => Promise<{ repository: MarketTailRepositoryV1 }>,
) {
  describe(`market tail repository (${label})`, () => {
    test('a tail that has never run has no cursor, not a zero', async () => {
      const { repository } = await open();
      assert.equal(await repository.readCursor({ tailKey: TAIL }), null);
    });

    test('one pass stores what it saw and what it cost', async () => {
      const { repository } = await open();
      const outcome = await repository.recordPass({
        tailKey: TAIL,
        chainId: 8453,
        toBlock: 50_428_100,
        observedAt: '2026-08-25T09:05:00.000Z',
        logCalls: 1,
        identityCalls: 4,
        venues: [venueFixtureV1()],
        events: [eventFixtureV1()],
      });
      assert.equal(outcome.inserted, 1);
      assert.equal(outcome.duplicates, 0);
      assert.equal(outcome.venuesAdded, 1);
      assert.equal(outcome.cursor.lastBlock, 50_428_100);
      // A background reader with no recorded price is a budget nobody can
      // defend, so the cost accumulates on the cursor itself.
      assert.equal(outcome.cursor.logCalls, 1);
      assert.equal(outcome.cursor.identityCalls, 4);
      assert.equal(outcome.cursor.eventsWritten, 1);
      assert.equal(outcome.cursor.passes, 1);
    });

    test('re-reading a range writes nothing and says so', async () => {
      const { repository } = await open();
      const pass = {
        tailKey: TAIL,
        chainId: 8453 as const,
        toBlock: 50_428_100,
        observedAt: '2026-08-25T09:05:00.000Z',
        logCalls: 1,
        identityCalls: 0,
        venues: [venueFixtureV1()],
        events: [eventFixtureV1()],
      };
      await repository.recordPass(pass);
      // The whole reorg policy the confirmation depth does not cover: a retry
      // after a partial failure needs no coordination at all.
      const again = await repository.recordPass({ ...pass, observedAt: '2026-08-25T09:10:00.000Z' });
      assert.equal(again.inserted, 0);
      assert.equal(again.duplicates, 1);
      assert.equal(again.venuesAdded, 0);
      assert.equal(again.cursor.eventsWritten, 1);
      assert.equal(again.cursor.passes, 2);
      assert.equal(again.cursor.logCalls, 2);
    });

    test('a cursor that would rewind is refused', async () => {
      const { repository } = await open();
      await repository.recordPass({
        tailKey: TAIL,
        chainId: 8453,
        toBlock: 50_428_100,
        observedAt: '2026-08-25T09:05:00.000Z',
        logCalls: 1,
        identityCalls: 0,
        venues: [],
        events: [],
      });
      await assert.rejects(
        repository.recordPass({
          tailKey: TAIL,
          chainId: 8453,
          toBlock: 50_000_000,
          observedAt: '2026-08-25T09:10:00.000Z',
          logCalls: 1,
          identityCalls: 0,
          venues: [],
          events: [],
        }),
        /re-scans history while appearing to work/,
      );
    });

    test('a movement through an address nobody identified is refused', async () => {
      const { repository } = await open();
      await assert.rejects(
        repository.recordPass({
          tailKey: TAIL,
          chainId: 8453,
          toBlock: 50_428_100,
          observedAt: '2026-08-25T09:05:00.000Z',
          logCalls: 1,
          identityCalls: 0,
          venues: [],
          events: [eventFixtureV1()],
        }),
        /the store has no such address/,
      );
    });

    test('a candidate is not evidence, and a router never becomes one', async () => {
      const { repository } = await open();
      await assert.rejects(
        repository.recordPass({
          tailKey: TAIL,
          chainId: 8453,
          toBlock: 50_428_100,
          observedAt: '2026-08-25T09:05:00.000Z',
          logCalls: 1,
          identityCalls: 0,
          venues: [venueFixtureV1({ kind: 'candidate', token0: null, token1: null, identifiedAt: null })],
          events: [eventFixtureV1()],
        }),
        /recorded as candidate/,
      );
      await assert.rejects(
        repository.recordPass({
          tailKey: TAIL,
          chainId: 8453,
          toBlock: 50_428_100,
          observedAt: '2026-08-25T09:06:00.000Z',
          venues: [
            venueFixtureV1({ address: ROUTER, kind: 'not_a_venue', token0: null, token1: null }),
          ],
          logCalls: 1,
          identityCalls: 2,
          events: [eventFixtureV1({ venueAddress: ROUTER })],
        }),
        /recorded as not_a_venue/,
      );
    });

    test('answering a candidate is counted apart from meeting a new address', async () => {
      const { repository } = await open();
      const first = await repository.recordPass({
        tailKey: TAIL,
        chainId: 8453,
        toBlock: 50_428_100,
        observedAt: '2026-08-25T09:00:00.000Z',
        logCalls: 1,
        identityCalls: 0,
        venues: [venueFixtureV1({ kind: 'candidate', token0: null, token1: null, identifiedAt: null })],
        events: [],
      });
      assert.equal(first.venuesAdded, 1);
      assert.equal(first.venuesIdentified, 0);

      const second = await repository.recordPass({
        tailKey: TAIL,
        chainId: 8453,
        toBlock: 50_428_200,
        observedAt: '2026-08-25T09:30:00.000Z',
        logCalls: 1,
        identityCalls: 2,
        venues: [venueFixtureV1({ firstSeenAt: '2026-08-25T09:30:00.000Z' })],
        events: [],
      });
      assert.equal(second.venuesAdded, 0);
      assert.equal(second.venuesIdentified, 1);

      const [stored] = await repository.venues({ chainId: 8453, limit: 10 });
      assert.equal(stored.kind, 'paired_pool');
      // How long we have watched an address survives the pass that identified it.
      assert.equal(stored.firstSeenAt, '2026-08-25T09:00:00.000Z');
    });

    test('a venue that is not a pool may not carry a pair', async () => {
      const { repository } = await open();
      await assert.rejects(
        repository.recordPass({
          tailKey: TAIL,
          chainId: 8453,
          toBlock: 50_428_100,
          observedAt: '2026-08-25T09:05:00.000Z',
          logCalls: 1,
          identityCalls: 0,
          venues: [venueFixtureV1({ address: SINGLETON, kind: 'singleton' })],
          events: [],
        }),
        /no pair of its own/,
      );
    });

    test('activity is counted per token, and an unobserved token is absent', async () => {
      const { repository } = await open();
      await repository.recordPass({
        tailKey: TAIL,
        chainId: 8453,
        toBlock: 50_428_300,
        observedAt: '2026-08-25T09:05:00.000Z',
        logCalls: 1,
        identityCalls: 0,
        venues: [venueFixtureV1(), venueFixtureV1({ address: SINGLETON, kind: 'singleton', token0: null, token1: null })],
        events: [
          eventFixtureV1(),
          eventFixtureV1({ logIndex: 8, direction: 'into_venue' }),
          eventFixtureV1({ logIndex: 9, blockNumber: 50_428_250, venueAddress: SINGLETON }),
        ],
      });
      const activity = await repository.venueActivity({
        chainId: 8453,
        tokenAddresses: [AAPL, NVDA],
        sinceBlock: 50_000_000,
      });
      // NVDAc is absent rather than zero: nothing was observed for it, which a
      // caller must not read as a measurement that found none.
      assert.deepEqual(activity, [
        {
          tokenAddress: AAPL,
          transfers: 3,
          acquired: 2,
          disposed: 1,
          firstBlock: 50_428_000,
          lastBlock: 50_428_250,
        },
      ]);
      const since = await repository.venueActivity({
        chainId: 8453,
        tokenAddresses: [AAPL],
        sinceBlock: 50_428_200,
      });
      assert.equal(since[0].transfers, 1);
    });

    // Retention (audit OPS-7): old transfers go, the count of what was ever
    // observed does not, and a transfer is removed for its age only.
    test('old transfers are removed in bounded passes, and the all-time count keeps them', async () => {
      const { repository } = await open();
      const pass = (toBlock: number, observedAt: string, events: MarketVenueTransferRowV1[]) =>
        repository.recordPass({
          tailKey: TAIL,
          chainId: 8453,
          toBlock,
          observedAt,
          logCalls: 1,
          identityCalls: 0,
          venues: [venueFixtureV1()],
          events,
        });
      await pass(50_428_100, '2026-08-25T09:00:00.000Z', [
        eventFixtureV1({ logIndex: 1, blockNumber: 50_428_010 }),
        eventFixtureV1({ logIndex: 2, blockNumber: 50_428_020, direction: 'into_venue' }),
        eventFixtureV1({ logIndex: 3, blockNumber: 50_428_030 }),
      ]);
      await pass(56_000_100, '2026-11-01T09:00:00.000Z', [
        eventFixtureV1({ logIndex: 4, blockNumber: 56_000_010, observedAt: '2026-11-01T09:00:00.000Z' }),
        // The same log again: counted once, in the rows and in the total.
        eventFixtureV1({ logIndex: 4, blockNumber: 56_000_010, observedAt: '2026-11-01T09:00:00.000Z' }),
      ]);
      const everything = {
        tokenAddress: AAPL,
        transfers: 4,
        acquired: 3,
        disposed: 1,
        firstBlock: 50_428_010,
        lastBlock: 56_000_010,
      };
      assert.deepEqual(await repository.venueActivityAllTime({ chainId: 8453, tokenAddresses: [AAPL, NVDA] }), [everything]);
      assert.deepEqual(await repository.venueActivity({ chainId: 8453, tokenAddresses: [AAPL], sinceBlock: 0 }), [everything]);

      // Bounded: two of the three old ones in the first pass, the third in the next.
      const before = '2026-10-01T00:00:00.000Z';
      assert.deepEqual(await repository.pruneTransfersObservedBefore({ chainId: 8453, before, limit: 2 }), { removed: 2 });
      assert.deepEqual(await repository.pruneTransfersObservedBefore({ chainId: 8453, before, limit: 2 }), { removed: 1 });
      // The newer transfer is among the oldest stored now, and stays: age decides, not the queue.
      assert.deepEqual(await repository.pruneTransfersObservedBefore({ chainId: 8453, before, limit: 2 }), { removed: 0 });
      // Another chain's rows are not this call's to remove.
      assert.deepEqual(
        await repository.pruneTransfersObservedBefore({ chainId: 1, before: '2027-01-01T00:00:00.000Z', limit: 10 }),
        { removed: 0 },
      );

      const kept = await repository.recentTransfers({ chainId: 8453, tokenAddress: AAPL, limit: 10 });
      assert.deepEqual(kept.map((row) => row.blockNumber), [56_000_010]);
      // A window now counts what is left…
      assert.deepEqual(await repository.venueActivity({ chainId: 8453, tokenAddresses: [AAPL], sinceBlock: 0 }), [
        { tokenAddress: AAPL, transfers: 1, acquired: 1, disposed: 0, firstBlock: 56_000_010, lastBlock: 56_000_010 },
      ]);
      // …and history is unchanged by the removal.
      assert.deepEqual(await repository.venueActivityAllTime({ chainId: 8453, tokenAddresses: [AAPL] }), [everything]);

      // A moment that is not a time removes nothing, loudly.
      await assert.rejects(
        repository.pruneTransfersObservedBefore({ chainId: 8453, before: 'yesterday', limit: 10 }),
        /not a time/,
      );
    });

    test('the newest observations come back newest first', async () => {
      const { repository } = await open();
      await repository.recordPass({
        tailKey: TAIL,
        chainId: 8453,
        toBlock: 50_428_300,
        observedAt: '2026-08-25T09:05:00.000Z',
        logCalls: 1,
        identityCalls: 0,
        venues: [venueFixtureV1()],
        events: [
          eventFixtureV1({ logIndex: 1, blockNumber: 50_428_010 }),
          eventFixtureV1({ logIndex: 2, blockNumber: 50_428_200 }),
        ],
      });
      const recent = await repository.recentTransfers({ chainId: 8453, tokenAddress: AAPL, limit: 1 });
      assert.equal(recent.length, 1);
      assert.equal(recent[0].blockNumber, 50_428_200);
    });

    test('candidates can be listed apart from identified venues', async () => {
      const { repository } = await open();
      await repository.recordPass({
        tailKey: TAIL,
        chainId: 8453,
        toBlock: 50_428_100,
        observedAt: '2026-08-25T09:05:00.000Z',
        logCalls: 1,
        identityCalls: 0,
        venues: [
          venueFixtureV1(),
          venueFixtureV1({ address: ROUTER, kind: 'candidate', token0: null, token1: null, identifiedAt: null }),
        ],
        events: [],
      });
      const candidates = await repository.venues({ chainId: 8453, kinds: ['candidate'], limit: 50 });
      assert.deepEqual(candidates.map((row) => row.address), [ROUTER]);
      const all = await repository.venues({ chainId: 8453, limit: 50 });
      assert.equal(all.length, 2);
    });
  });
}
