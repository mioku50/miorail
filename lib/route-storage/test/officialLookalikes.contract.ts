import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type {
  OfficialLookalikeRepositoryV1,
  OfficialLookalikeRowV1,
} from '../src/officialLookalikes.js';

const AAPL = '0xb200000000000000000000c2e324d24d7eecd1fb';
const NVDA = '0xb20000000000000000000078ee7ce2fe4908108c';
const IMPOSTOR = '0xb200000000000000000000dead0000000000ad01';
const SECOND = '0xb200000000000000000000beef0000000000be02';
const CORPUS = [AAPL, NVDA];

function rowFixtureV1(overrides: Partial<OfficialLookalikeRowV1> = {}): OfficialLookalikeRowV1 {
  return {
    chainId: 8453,
    tokenAddress: IMPOSTOR,
    officialAddress: AAPL,
    matchKind: 'symbol_exact',
    matchedAlias: 'published_ticker',
    matchedValue: 'AAPLc',
    launchSymbol: 'AAPLc',
    launchName: 'Apple',
    launchedAt: '2026-08-20T10:00:00.000Z',
    firstFlaggedAt: '2026-08-25T09:00:00.000Z',
    lastSeenAt: '2026-08-25T09:00:00.000Z',
    ...overrides,
  } as OfficialLookalikeRowV1;
}

/**
 * The contract both repositories are held to.
 *
 * Every case is a way this feature could accuse the wrong contract, or could
 * turn a resemblance into a verdict.
 */
export function officialLookalikeContractV1(
  label: string,
  open: () => Promise<{ repository: OfficialLookalikeRepositoryV1 }>,
) {
  describe(`official lookalike repository (${label})`, () => {
    test('an unflagged address reads as null, not as cleared', async () => {
      const { repository } = await open();
      // Null means nothing matched. It does not mean the contract was checked
      // and found honest, and no surface may render it that way.
      assert.equal(await repository.lookalikeFor({ chainId: 8453, tokenAddress: IMPOSTOR }), null);
      assert.deepEqual(await repository.recentLookalikes({ chainId: 8453, limit: 10 }), []);
    });

    test('a scan stores the resemblance with both addresses', async () => {
      const { repository } = await open();
      const outcome = await repository.recordLookalikes({
        chainId: 8453,
        officialAddresses: CORPUS,
        rows: [rowFixtureV1()],
      });
      assert.deepEqual(outcome, { flagged: [IMPOSTOR], refreshed: [] });

      const stored = await repository.lookalikeFor({ chainId: 8453, tokenAddress: IMPOSTOR });
      assert.equal(stored?.officialAddress, AAPL);
      assert.equal(stored?.matchedValue, 'AAPLc');
      assert.equal(stored?.launchSymbol, 'AAPLc');
      // A comparison with one address in it is the shape that gets misread.
      assert.notEqual(stored?.tokenAddress, stored?.officialAddress);
    });

    test('an official contract can never be recorded as an impostor', async () => {
      const { repository } = await open();
      await assert.rejects(
        repository.recordLookalikes({
          chainId: 8453,
          officialAddresses: CORPUS,
          rows: [rowFixtureV1({ tokenAddress: NVDA })],
        }),
        /itself an official contract/,
      );
      // Not of itself either, which the schema refuses before the corpus check.
      await assert.rejects(
        repository.recordLookalikes({
          chainId: 8453,
          officialAddresses: CORPUS,
          rows: [rowFixtureV1({ tokenAddress: AAPL, officialAddress: AAPL })],
        }),
        /cannot be a lookalike of itself/,
      );
    });

    test('a row naming an official the corpus does not contain is refused', async () => {
      const { repository } = await open();
      // A stale or invented reference would render as a comparison against
      // nothing.
      await assert.rejects(
        repository.recordLookalikes({
          chainId: 8453,
          officialAddresses: CORPUS,
          rows: [rowFixtureV1({ officialAddress: SECOND })],
        }),
        /the corpus does not contain that address/,
      );
    });

    test('one refused row leaves no half-written scan behind', async () => {
      const { repository } = await open();
      await assert.rejects(
        repository.recordLookalikes({
          chainId: 8453,
          officialAddresses: CORPUS,
          rows: [rowFixtureV1(), rowFixtureV1({ tokenAddress: NVDA })],
        }),
        /itself an official contract/,
      );
      assert.equal(await repository.lookalikeFor({ chainId: 8453, tokenAddress: IMPOSTOR }), null);
    });

    test('when it started wearing the name survives a later scan', async () => {
      const { repository } = await open();
      await repository.recordLookalikes({ chainId: 8453, officialAddresses: CORPUS, rows: [rowFixtureV1()] });
      const again = await repository.recordLookalikes({
        chainId: 8453,
        officialAddresses: CORPUS,
        rows: [
          rowFixtureV1({
            firstFlaggedAt: '2026-08-26T09:00:00.000Z',
            lastSeenAt: '2026-08-26T09:00:00.000Z',
            launchName: 'Apple Inc',
          }),
        ],
      });
      assert.deepEqual(again, { flagged: [], refreshed: [IMPOSTOR] });
      const stored = await repository.lookalikeFor({ chainId: 8453, tokenAddress: IMPOSTOR });
      assert.equal(stored?.firstFlaggedAt, '2026-08-25T09:00:00.000Z');
      assert.equal(stored?.lastSeenAt, '2026-08-26T09:00:00.000Z');
      assert.equal(stored?.launchName, 'Apple Inc');
    });

    test('an official asset lists what wears its name, newest first', async () => {
      const { repository } = await open();
      await repository.recordLookalikes({
        chainId: 8453,
        officialAddresses: CORPUS,
        rows: [
          rowFixtureV1(),
          rowFixtureV1({
            tokenAddress: SECOND,
            firstFlaggedAt: '2026-08-26T09:00:00.000Z',
            lastSeenAt: '2026-08-26T09:00:00.000Z',
          }),
          rowFixtureV1({
            tokenAddress: '0xb200000000000000000000cafe0000000000ca03',
            officialAddress: NVDA,
            matchedValue: 'NVDA',
            launchSymbol: 'NVDA',
          }),
        ],
      });
      const apple = await repository.lookalikesOf({ chainId: 8453, officialAddress: AAPL, limit: 10 });
      assert.deepEqual(apple.map((row) => row.tokenAddress), [SECOND, IMPOSTOR]);
      const nvidia = await repository.lookalikesOf({ chainId: 8453, officialAddress: NVDA, limit: 10 });
      assert.equal(nvidia.length, 1);
      const feed = await repository.recentLookalikes({ chainId: 8453, limit: 2 });
      assert.equal(feed.length, 2);
      assert.equal(feed[0].tokenAddress, SECOND);
    });

    test('a launch the index cannot date is stored undated, not at the epoch', async () => {
      const { repository } = await open();
      await repository.recordLookalikes({
        chainId: 8453,
        officialAddresses: CORPUS,
        rows: [rowFixtureV1({ launchedAt: null })],
      });
      const stored = await repository.lookalikeFor({ chainId: 8453, tokenAddress: IMPOSTOR });
      assert.equal(stored?.launchedAt, null);
    });

    test('the feed narrows to one spelling, and the counts describe the corpus', async () => {
      const { repository } = await open();
      await repository.recordLookalikes({
        chainId: 8453,
        officialAddresses: CORPUS,
        rows: [
          rowFixtureV1(),
          rowFixtureV1({
            tokenAddress: SECOND,
            matchedAlias: 'underlying',
            matchedValue: 'aapl',
            launchSymbol: 'AAPL',
            firstFlaggedAt: '2026-08-26T09:00:00.000Z',
            lastSeenAt: '2026-08-26T09:00:00.000Z',
          }),
          rowFixtureV1({
            tokenAddress: '0xb200000000000000000000cafe0000000000ca03',
            matchedAlias: 'underlying',
            matchedValue: 'aapl',
            launchSymbol: 'AAPL',
            firstFlaggedAt: '2026-08-27T09:00:00.000Z',
            lastSeenAt: '2026-08-27T09:00:00.000Z',
          }),
        ],
      });

      const underlying = await repository.recentLookalikes({
        chainId: 8453,
        matchedAlias: 'underlying',
        limit: 10,
      });
      assert.deepEqual(
        underlying.map((row) => row.tokenAddress),
        ['0xb200000000000000000000cafe0000000000ca03', SECOND],
      );
      const ticker = await repository.recentLookalikes({
        chainId: 8453,
        matchedAlias: 'published_ticker',
        limit: 10,
      });
      assert.deepEqual(ticker.map((row) => row.tokenAddress), [IMPOSTOR]);

      const counts = await repository.lookalikeCounts({ chainId: 8453 });
      assert.equal(counts.total, 3);
      // Every kind is present even at zero. A filter that disappears when it is
      // empty reads as a filter the product does not have.
      assert.deepEqual(counts.byAlias, { published_ticker: 1, underlying: 2, display_name: 0 });
      assert.equal(counts.lastSeenAt, '2026-08-27T09:00:00.000Z');

      const byOfficial = await repository.lookalikeCountsByOfficial({ chainId: 8453 });
      assert.deepEqual(byOfficial, { [AAPL]: 3 });
    });

    test('nothing scanned yet is an absent date, not a scan that found nothing', async () => {
      const { repository } = await open();
      const counts = await repository.lookalikeCounts({ chainId: 8453 });
      assert.equal(counts.total, 0);
      assert.equal(counts.lastSeenAt, null);
      assert.deepEqual(counts.byAlias, { published_ticker: 0, underlying: 0, display_name: 0 });
      assert.deepEqual(await repository.lookalikeCountsByOfficial({ chainId: 8453 }), {});
    });
  });
}
