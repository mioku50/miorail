import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { RouteStorageIntegrityError } from '../src/types.js';
import type {
  B20CorporateActionRepositoryV1,
  B20CorporateActionRowV1,
} from '../src/b20CorporateActions.js';

const AAPL = '0xb200000000000000000000c2e324d24d7eecd1fb';
const NVDA = '0xb200000000000000000000beef0000000000be02';
const OPERATOR = '0x00000000000000000000000000000000000000aa';
const TX = '0x' + 'a'.repeat(64);
const TX2 = '0x' + 'b'.repeat(64);

function announcementV1(overrides: Partial<B20CorporateActionRowV1> = {}): B20CorporateActionRowV1 {
  return {
    chainId: 8453,
    tokenAddress: AAPL,
    event: 'announcement',
    payloadState: 'decoded',
    announcementId: '2026-01',
    caller: OPERATOR,
    description: 'cash dividend',
    uri: 'https://example.test/2026-01',
    multiplierWad: null,
    topics: ['0x' + 'c'.repeat(64)],
    data: '0xabcdef',
    blockNumber: 50_430_000,
    blockTime: '2026-09-12T10:00:00.000Z',
    transactionHash: TX,
    logIndex: 3,
    observedAt: '2026-09-12T10:05:00.000Z',
    ...overrides,
  };
}

/**
 * The contract both repositories are held to.
 *
 * Every case is a way this record could describe a corporate action that did
 * not happen the way it says: a half-decoded announcement presented as a
 * complete one, a payload carried on a row that claims it read nothing, one
 * log counted twice, a cursor walking backwards over ground it already read.
 */
export function b20CorporateActionContractV1(
  label: string,
  open: () => Promise<{ repository: B20CorporateActionRepositoryV1 }>,
): void {
  describe(`${label} b20 corporate actions`, () => {
    test('stores an announcement and reads it back unchanged', async () => {
      const { repository } = await open();
      const outcome = await repository.recordPass({
        chainId: 8453,
        fromBlock: 50_420_000,
        toBlock: 50_430_100,
        observedAt: '2026-09-12T10:05:00.000Z',
        logCalls: 2,
        rows: [announcementV1()],
      });
      assert.equal(outcome.inserted, 1);
      assert.equal(outcome.duplicates, 0);
      assert.equal(outcome.lastBlock, 50_430_100);

      const [row] = await repository.actionsFor({ chainId: 8453, tokenAddress: AAPL, limit: 10 });
      assert.ok(row);
      assert.equal(row.description, 'cash dividend');
      assert.equal(row.announcementId, '2026-01');
      // The raw log travels with the row, always: it is what makes a payload
      // this build could not read recoverable by one that can.
      assert.equal(row.data, '0xabcdef');
      assert.deepEqual(row.topics, ['0x' + 'c'.repeat(64)]);
    });

    test('one log is one row, however often the range is re-read', async () => {
      const { repository } = await open();
      const first = await repository.recordPass({
        chainId: 8453,
        fromBlock: 50_420_000,
        toBlock: 50_430_100,
        observedAt: '2026-09-12T10:05:00.000Z',
        logCalls: 1,
        rows: [announcementV1()],
      });
      const again = await repository.recordPass({
        chainId: 8453,
        fromBlock: 50_420_000,
        toBlock: 50_430_100,
        observedAt: '2026-09-12T11:05:00.000Z',
        logCalls: 1,
        rows: [announcementV1({ observedAt: '2026-09-12T11:05:00.000Z' })],
      });
      assert.equal(first.inserted, 1);
      assert.equal(again.inserted, 0);
      assert.equal(again.duplicates, 1);
      const rows = await repository.actionsFor({ chainId: 8453, tokenAddress: AAPL, limit: 10 });
      assert.equal(rows.length, 1);
    });

    test('a half-read announcement is refused rather than stored as a complete one', async () => {
      const { repository } = await open();
      await assert.rejects(
        repository.recordPass({
          chainId: 8453,
          fromBlock: 50_420_000,
          toBlock: 50_430_100,
          observedAt: '2026-09-12T10:05:00.000Z',
          logCalls: 1,
          rows: [announcementV1({ description: null })],
        }),
        RouteStorageIntegrityError,
      );
      const rows = await repository.recentActions({ chainId: 8453, limit: 10 });
      assert.equal(rows.length, 0, 'a refused pass writes nothing');
    });

    test('a row that read nothing may not carry anything', async () => {
      const { repository } = await open();
      await assert.rejects(
        repository.recordPass({
          chainId: 8453,
          fromBlock: 50_420_000,
          toBlock: 50_430_100,
          observedAt: '2026-09-12T10:05:00.000Z',
          logCalls: 1,
          rows: [announcementV1({ payloadState: 'topic_only' })],
        }),
        RouteStorageIntegrityError,
      );
    });

    test('an unreadable payload is stored as the event alone', async () => {
      const { repository } = await open();
      await repository.recordPass({
        chainId: 8453,
        fromBlock: 50_420_000,
        toBlock: 50_430_100,
        observedAt: '2026-09-12T10:05:00.000Z',
        logCalls: 1,
        rows: [
          announcementV1({
            payloadState: 'topic_only',
            announcementId: null,
            caller: null,
            description: null,
            uri: null,
          }),
        ],
      });
      const [row] = await repository.actionsFor({ chainId: 8453, tokenAddress: AAPL, limit: 10 });
      assert.equal(row!.payloadState, 'topic_only');
      assert.equal(row!.description, null);
      assert.equal(row!.data, '0xabcdef', 'the bytes are kept so a later reader can do better');
    });

    test('a multiplier event carries a multiplier and no announcement text', async () => {
      const { repository } = await open();
      await repository.recordPass({
        chainId: 8453,
        fromBlock: 50_420_000,
        toBlock: 50_430_100,
        observedAt: '2026-09-12T10:05:00.000Z',
        logCalls: 1,
        rows: [
          announcementV1({
            event: 'multiplier_updated',
            announcementId: null,
            caller: null,
            description: null,
            uri: null,
            multiplierWad: '1057380318816778075',
          }),
        ],
      });
      const [row] = await repository.actionsFor({ chainId: 8453, tokenAddress: AAPL, limit: 10 });
      assert.equal(row!.multiplierWad, '1057380318816778075');

      await assert.rejects(
        repository.recordPass({
          chainId: 8453,
          fromBlock: 50_420_000,
          toBlock: 50_430_200,
          observedAt: '2026-09-12T10:06:00.000Z',
          logCalls: 1,
          rows: [
            announcementV1({
              event: 'multiplier_updated',
              transactionHash: TX2,
              multiplierWad: '1000000000000000000',
            }),
          ],
        }),
        RouteStorageIntegrityError,
        'a multiplier event with a description is two events in one row',
      );
    });

    test('an action cannot have been read before the block that carried it', async () => {
      const { repository } = await open();
      await assert.rejects(
        repository.recordPass({
          chainId: 8453,
          fromBlock: 50_420_000,
          toBlock: 50_430_100,
          observedAt: '2026-09-12T10:05:00.000Z',
          logCalls: 1,
          rows: [announcementV1({ blockTime: '2026-09-12T12:00:00.000Z' })],
        }),
        RouteStorageIntegrityError,
      );
    });

    test('the record says what range it covers, and the start never moves', async () => {
      // An empty feed is evidence of quiet only across a range somebody can
      // name. `firstBlock` is written by the pass that opens the record and
      // never again — a start that moved with every pass would shrink the range
      // it claims while looking like it grew.
      const { repository } = await open();
      assert.deepEqual(await repository.coverage({ chainId: 8453 }), {
        firstBlock: null,
        lastBlock: null,
        actions: 0,
      });

      await repository.recordPass({
        chainId: 8453,
        fromBlock: 49_145_000,
        toBlock: 49_155_000,
        observedAt: '2026-09-12T10:05:00.000Z',
        logCalls: 1,
        rows: [],
      });
      await repository.recordPass({
        chainId: 8453,
        fromBlock: 49_155_001,
        toBlock: 50_430_100,
        observedAt: '2026-09-12T10:06:00.000Z',
        logCalls: 1,
        rows: [announcementV1()],
      });
      assert.deepEqual(await repository.coverage({ chainId: 8453 }), {
        firstBlock: 49_145_000,
        lastBlock: 50_430_100,
        actions: 1,
      });
    });

    test('the cursor does not rewind', async () => {
      const { repository } = await open();
      await repository.recordPass({
        chainId: 8453,
        fromBlock: 50_420_000,
        toBlock: 50_430_100,
        observedAt: '2026-09-12T10:05:00.000Z',
        logCalls: 1,
        rows: [],
      });
      await assert.rejects(
        repository.recordPass({
          chainId: 8453,
          fromBlock: 50_420_000,
          toBlock: 50_420_000,
          observedAt: '2026-09-12T10:06:00.000Z',
          logCalls: 1,
          rows: [],
        }),
        RouteStorageIntegrityError,
      );
    });

    test('the feed is newest first, and one asset sees only its own', async () => {
      const { repository } = await open();
      await repository.recordPass({
        chainId: 8453,
        fromBlock: 50_420_000,
        toBlock: 50_430_200,
        observedAt: '2026-09-12T11:05:00.000Z',
        logCalls: 1,
        rows: [
          announcementV1(),
          announcementV1({
            tokenAddress: NVDA,
            transactionHash: TX2,
            logIndex: 0,
            announcementId: '2026-02',
            description: 'stock split',
            blockTime: '2026-09-12T11:00:00.000Z',
            observedAt: '2026-09-12T11:05:00.000Z',
          }),
        ],
      });
      const feed = await repository.recentActions({ chainId: 8453, limit: 10 });
      assert.deepEqual(
        feed.map((row) => row.announcementId),
        ['2026-02', '2026-01'],
      );
      const one = await repository.actionsFor({ chainId: 8453, tokenAddress: NVDA, limit: 10 });
      assert.deepEqual(one.map((row) => row.tokenAddress), [NVDA]);

      const recent = await repository.recentActions({
        chainId: 8453,
        since: '2026-09-12T10:30:00.000Z',
        limit: 10,
      });
      assert.deepEqual(recent.map((row) => row.announcementId), ['2026-02']);
    });
  });
}
