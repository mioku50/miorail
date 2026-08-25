import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { RouteStorageIntegrityError } from '../src/types.js';
import {
  RwaSignalNotWatchedError,
  type RwaSignalRepositoryV1,
  type RwaSignalV1,
} from '../src/rwaSignals.js';

const AAPL = '0xb200000000000000000000c2e324d24d7eecd1fb';
const IMPOSTOR = '0xb200000000000000000000dead0000000000ad01';
const SECOND = '0xb200000000000000000000beef0000000000be02';

function lookalikeSignalV1(overrides: Partial<RwaSignalV1> = {}): RwaSignalV1 {
  return {
    kind: 'official_asset_lookalike_created',
    chainId: 8453,
    subjectAddress: IMPOSTOR,
    officialAddress: AAPL,
    occurredAt: '2026-08-25T12:00:00.000Z',
    dedupeKey: `official_asset_lookalike_created:${IMPOSTOR}`,
    facts: {
      matchKind: 'symbol_exact',
      matchedAlias: 'published_ticker',
      matchedValue: 'AAPLc',
      officialTicker: 'AAPLc',
      launchSymbol: 'AAPLc',
      launchName: 'Apple',
    },
    ...overrides,
  } as RwaSignalV1;
}

/**
 * The contract both repositories are held to.
 *
 * Every case is a way this feed could report something that did not happen:
 * an unwatched kind (the corpus announced as news on the first pass), a
 * backdated transition (history dressed as a change), a re-run writing the
 * same event twice.
 */
export function rwaSignalContractV1(
  label: string,
  open: () => Promise<{ repository: RwaSignalRepositoryV1 }>,
): void {
  describe(`rwa signal repository (${label})`, () => {
    test('the pass that opens a watch is told so, and every later one is not', async () => {
      const { repository } = await open();
      const first = await repository.openSignalWatch({
        chainId: 8453,
        kinds: ['official_asset_lookalike_created'],
        at: '2026-08-25T10:00:00.000Z',
      });
      assert.deepEqual(
        first.map((row) => [row.kind, row.watchingSince, row.openedNow]),
        [['official_asset_lookalike_created', '2026-08-25T10:00:00.000Z', true]],
      );

      const second = await repository.openSignalWatch({
        chainId: 8453,
        kinds: ['official_asset_lookalike_created'],
        // A later pass with a later clock must not move the watch: when we
        // started looking is a fact, and rewriting it would let a backfill
        // re-report everything it had already skipped.
        at: '2026-08-26T10:00:00.000Z',
      });
      assert.deepEqual(
        second.map((row) => [row.watchingSince, row.openedNow]),
        [['2026-08-25T10:00:00.000Z', false]],
      );
    });

    test('a kind nobody is watching cannot record a change', async () => {
      const { repository } = await open();
      await assert.rejects(
        repository.recordSignals({
          chainId: 8453,
          recordedAt: '2026-08-25T12:00:01.000Z',
          signals: [lookalikeSignalV1()],
        }),
        (error: unknown) => error instanceof RwaSignalNotWatchedError,
      );
      assert.deepEqual(await repository.recentSignals({ chainId: 8453, limit: 10 }), []);
    });

    test('a transition dated before the watch opened is history, and is refused', async () => {
      const { repository } = await open();
      await repository.openSignalWatch({
        chainId: 8453,
        kinds: ['official_asset_lookalike_created'],
        at: '2026-08-25T10:00:00.000Z',
      });
      await assert.rejects(
        repository.recordSignals({
          chainId: 8453,
          recordedAt: '2026-08-25T12:00:00.000Z',
          signals: [lookalikeSignalV1({ occurredAt: '2026-08-20T10:00:00.000Z' })],
        }),
        (error: unknown) => error instanceof RouteStorageIntegrityError,
      );
      assert.deepEqual(await repository.recentSignals({ chainId: 8453, limit: 10 }), []);
    });

    test('one refused signal writes none of the pass', async () => {
      const { repository } = await open();
      await repository.openSignalWatch({
        chainId: 8453,
        kinds: ['official_asset_lookalike_created'],
        at: '2026-08-25T10:00:00.000Z',
      });
      await assert.rejects(
        repository.recordSignals({
          chainId: 8453,
          recordedAt: '2026-08-25T12:00:01.000Z',
          signals: [
            lookalikeSignalV1(),
            lookalikeSignalV1({
              subjectAddress: SECOND,
              dedupeKey: `official_asset_lookalike_created:${SECOND}`,
              occurredAt: '2026-08-01T10:00:00.000Z',
            }),
          ],
        }),
      );
      // A feed holding half a story is worse than one holding none: the reader
      // cannot tell which half is missing.
      assert.deepEqual(await repository.recentSignals({ chainId: 8453, limit: 10 }), []);
    });

    test('a re-run over the same window records nothing twice', async () => {
      const { repository } = await open();
      await repository.openSignalWatch({
        chainId: 8453,
        kinds: ['official_asset_lookalike_created'],
        at: '2026-08-25T10:00:00.000Z',
      });
      const first = await repository.recordSignals({
        chainId: 8453,
        recordedAt: '2026-08-25T12:00:01.000Z',
        signals: [lookalikeSignalV1()],
      });
      assert.deepEqual(first.recorded.length, 1);
      const again = await repository.recordSignals({
        chainId: 8453,
        recordedAt: '2026-08-25T13:00:01.000Z',
        signals: [lookalikeSignalV1()],
      });
      assert.deepEqual(again.recorded, []);
      assert.deepEqual(again.alreadyRecorded.length, 1);
      assert.equal((await repository.recentSignals({ chainId: 8453, limit: 10 })).length, 1);
    });

    test('the feed is newest first, narrows by kind, and keeps both timestamps apart', async () => {
      const { repository } = await open();
      await repository.openSignalWatch({
        chainId: 8453,
        kinds: ['official_asset_lookalike_created', 'official_asset_market_became_active'],
        at: '2026-08-25T10:00:00.000Z',
      });
      await repository.recordSignals({
        chainId: 8453,
        recordedAt: '2026-08-25T18:00:00.000Z',
        signals: [
          lookalikeSignalV1(),
          {
            kind: 'official_asset_market_became_active',
            chainId: 8453,
            subjectAddress: AAPL,
            officialAddress: null,
            occurredAt: '2026-08-25T17:00:00.000Z',
            dedupeKey: 'official_asset_market_became_active:aapl:run1',
            facts: {
              ticker: 'AAPLc',
              destination: 'USDC',
              requestedCashAtomic: '100000000',
              roundTripCostBps: '11',
              approvedSources: ['kyberswap'],
            },
          } as RwaSignalV1,
        ],
      });

      const feed = await repository.recentSignals({ chainId: 8453, limit: 10 });
      assert.deepEqual(feed.map((row) => row.kind), [
        'official_asset_market_became_active',
        'official_asset_lookalike_created',
      ]);
      // When it happened and when we wrote it are separate facts. A pass that
      // catches up after an outage must not date its findings to itself.
      assert.equal(feed[0].occurredAt, '2026-08-25T17:00:00.000Z');
      assert.equal(feed[0].recordedAt, '2026-08-25T18:00:00.000Z');

      const narrowed = await repository.recentSignals({
        chainId: 8453,
        kinds: ['official_asset_lookalike_created'],
        limit: 10,
      });
      assert.deepEqual(narrowed.map((row) => row.subjectAddress), [IMPOSTOR]);

      const forAsset = await repository.signalsForSubject({
        chainId: 8453,
        subjectAddress: AAPL,
        limit: 10,
      });
      assert.deepEqual(forAsset.map((row) => row.kind), ['official_asset_market_became_active']);
    });

    test('a signal cannot name one contract as both the subject and the official', async () => {
      const { repository } = await open();
      await repository.openSignalWatch({
        chainId: 8453,
        kinds: ['official_asset_lookalike_created'],
        at: '2026-08-25T10:00:00.000Z',
      });
      await assert.rejects(
        repository.recordSignals({
          chainId: 8453,
          recordedAt: '2026-08-25T12:00:01.000Z',
          signals: [lookalikeSignalV1({ subjectAddress: AAPL })],
        }),
        (error: unknown) => error instanceof RouteStorageIntegrityError,
      );
    });

    test('the open watch is readable, so an empty feed can say what it means', async () => {
      const { repository } = await open();
      assert.deepEqual(await repository.signalWatch({ chainId: 8453 }), []);
      await repository.openSignalWatch({
        chainId: 8453,
        kinds: ['official_source_added_asset', 'official_source_removed_asset'],
        at: '2026-08-25T10:00:00.000Z',
      });
      assert.deepEqual(
        (await repository.signalWatch({ chainId: 8453 })).map((row) => row.kind),
        ['official_source_added_asset', 'official_source_removed_asset'],
      );
    });
  });
}
