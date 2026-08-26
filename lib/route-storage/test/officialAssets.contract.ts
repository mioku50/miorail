import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  isOfficialV1,
  type OfficialAssetInputV1,
  type OfficialAssetRepositoryV1,
  type OfficialSourceSnapshotV1,
} from '../src/officialAssets.js';

/** The address Base's own technical corpus publishes for tokenized Apple. */
const AAPL = '0xb200000000000000000000c2e324d24d7eecd1fb';
/** Same ticker, different contract. This is what a lookalike is. */
const LOOKALIKE = '0xb200000000000000000000dead0000000000ad01';
const SNDK = '0xb200000000000000000000397293cb8cda9a10c5';

const DOCS_URL = 'https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base.md';
const LIST_URL = 'https://brand.base.org/stocks';
const BACKED_URL = 'https://api.xstocks.fi/api/v1/token?type=btokens';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function snapshotFixtureV1(overrides: Partial<OfficialSourceSnapshotV1> = {}): OfficialSourceSnapshotV1 {
  return {
    sourceKind: 'base_docs_technical',
    sourceUrl: DOCS_URL,
    observedAt: '2026-08-25T09:00:00.000Z',
    status: 'ok',
    documentHash: HASH_A,
    corpusHash: HASH_B,
    detail: null,
    ...overrides,
  } as OfficialSourceSnapshotV1;
}

function assetFixtureV1(overrides: Partial<OfficialAssetInputV1> = {}): OfficialAssetInputV1 {
  return {
    chainId: 8453,
    tokenAddress: AAPL,
    sourceKind: 'base_docs_technical',
    ticker: 'AAPLc',
    displayName: 'Apple',
    issuer: 'coinbase',
    referenceFeedAddress: '0x787f13dea48db0897cbcdd985de77809d837f988',
    ...overrides,
  } as OfficialAssetInputV1;
}

/**
 * The contract both repositories are held to.
 *
 * Every case here is a route by which a lookalike could inherit an official
 * identity, or by which one of OUR failures could be published as a fact about
 * an asset. The database enforces most of them with CHECK constraints; the
 * in-memory fake has to refuse exactly the same writes, because a fake that is
 * more permissive lets a test pass on a row production cannot store.
 */
export function officialAssetContractV1(
  label: string,
  open: () => Promise<{ repository: OfficialAssetRepositoryV1 }>,
) {
  describe(`official asset repository (${label})`, () => {
    test('an address no source has listed reads as null, not as an empty identity', async () => {
      const { repository } = await open();
      assert.equal(await repository.officialIdentity({ chainId: 8453, tokenAddress: AAPL }), null);
      assert.equal(isOfficialV1(null), false);
      assert.equal(await repository.latestSnapshot({ sourceKind: 'base_docs_technical' }), null);
    });

    test('a completed check makes an address official, and stores what said so', async () => {
      const { repository } = await open();
      const outcome = await repository.recordSnapshot({
        snapshot: snapshotFixtureV1(),
        assets: [assetFixtureV1()],
      });
      assert.deepEqual(outcome.added, [AAPL]);
      assert.deepEqual(outcome.delisted, []);

      const identity = await repository.officialIdentity({ chainId: 8453, tokenAddress: AAPL });
      assert.ok(identity);
      assert.equal(isOfficialV1(identity), true);
      assert.equal(identity.listings.length, 1);
      const [listing] = identity.listings;
      assert.equal(listing.sourceKind, 'base_docs_technical');
      assert.equal(listing.sourceUrl, DOCS_URL);
      assert.equal(listing.ticker, 'AAPLc');
      assert.equal(listing.referenceFeedAddress, '0x787f13dea48db0897cbcdd985de77809d837f988');
      assert.equal(listing.currentlyListed, true);
      assert.equal(listing.sourceCheckedAt, '2026-08-25T09:00:00.000Z');
      assert.equal(listing.sourceStatus, 'ok');

      const snapshot = await repository.latestSnapshot({ sourceKind: 'base_docs_technical' });
      assert.equal(snapshot?.assetCount, 1);
      assert.equal(snapshot?.corpusHash, HASH_B);
    });

    test('sharing a ticker with an official asset establishes nothing', async () => {
      const { repository } = await open();
      await repository.recordSnapshot({ snapshot: snapshotFixtureV1(), assets: [assetFixtureV1()] });
      // The lookalike carries the same ticker, the same name and the same
      // issuer string. It is a different contract, so it is a different asset,
      // and there is no read on this interface that could confuse them.
      assert.equal(
        await repository.officialIdentity({ chainId: 8453, tokenAddress: LOOKALIKE }),
        null,
      );
      const official = await repository.officialAssets({ chainId: 8453, limit: 50 });
      assert.deepEqual(
        official.map((identity) => identity.tokenAddress),
        [AAPL],
      );
    });

    test('a source that could not be read withdraws nothing', async () => {
      const { repository } = await open();
      await repository.recordSnapshot({ snapshot: snapshotFixtureV1(), assets: [assetFixtureV1()] });
      const outcome = await repository.recordSnapshot({
        snapshot: snapshotFixtureV1({
          observedAt: '2026-08-25T10:00:00.000Z',
          status: 'unreachable',
          documentHash: null,
          corpusHash: null,
          detail: 'request timed out',
        }),
        assets: [],
      });
      assert.deepEqual(outcome, {
        snapshotId: outcome.snapshotId,
        sourceKind: 'base_docs_technical',
        status: 'unreachable',
        observedAt: '2026-08-25T10:00:00.000Z',
        added: [],
        stillListed: [],
        delisted: [],
      });

      const identity = await repository.officialIdentity({ chainId: 8453, tokenAddress: AAPL });
      // Still official. Only the freshness moved, and it says which way.
      assert.equal(identity?.listings[0].currentlyListed, true);
      assert.equal(identity?.listings[0].sourceStatus, 'unreachable');
      assert.equal(identity?.listings[0].sourceCheckedAt, '2026-08-25T10:00:00.000Z');
      assert.equal(identity?.listings[0].lastSeenAt, '2026-08-25T09:00:00.000Z');
    });

    test('an ok check that named nothing is refused', async () => {
      const { repository } = await open();
      // The day a reviewed page changes its markup, an empty parse is the
      // answer that would silently empty the official set. It has to be
      // recorded as unparsable instead, which is a fact about us.
      await assert.rejects(
        repository.recordSnapshot({ snapshot: snapshotFixtureV1(), assets: [] }),
        /named no assets/,
      );
      await assert.rejects(
        repository.recordSnapshot({
          snapshot: snapshotFixtureV1({ status: 'unparsable', documentHash: HASH_A, corpusHash: null }),
          assets: [assetFixtureV1()],
        }),
        /says nothing about membership/,
      );
    });

    test('an asset may not claim a source other than the snapshot it arrived in', async () => {
      const { repository } = await open();
      await assert.rejects(
        repository.recordSnapshot({
          snapshot: snapshotFixtureV1(),
          assets: [assetFixtureV1({ sourceKind: 'base_product_list' })],
        }),
        /claims source base_product_list/,
      );
    });

    test('an address that is not already normalized is refused', async () => {
      const { repository } = await open();
      await assert.rejects(
        repository.recordSnapshot({
          snapshot: snapshotFixtureV1(),
          assets: [assetFixtureV1({ tokenAddress: '0xB200000000000000000000C2e324d24d7eEcd1fb' })],
        }),
        /lowercase 20-byte address/,
      );
    });

    test('a source dropping an asset is reported once, on the check that dropped it', async () => {
      const { repository } = await open();
      await repository.recordSnapshot({
        snapshot: snapshotFixtureV1(),
        assets: [assetFixtureV1(), assetFixtureV1({ tokenAddress: SNDK, ticker: 'SNDKc', displayName: null })],
      });
      const dropped = await repository.recordSnapshot({
        snapshot: snapshotFixtureV1({ observedAt: '2026-08-25T10:00:00.000Z', corpusHash: 'c'.repeat(64) }),
        assets: [assetFixtureV1()],
      });
      assert.deepEqual(dropped.delisted, [SNDK]);
      assert.deepEqual(dropped.stillListed, [AAPL]);
      assert.deepEqual(dropped.added, []);

      const again = await repository.recordSnapshot({
        snapshot: snapshotFixtureV1({ observedAt: '2026-08-25T11:00:00.000Z', corpusHash: 'c'.repeat(64) }),
        assets: [assetFixtureV1()],
      });
      // An event that re-fires every pass is noise wearing an event's name.
      assert.deepEqual(again.delisted, []);

      const sndk = await repository.officialIdentity({ chainId: 8453, tokenAddress: SNDK });
      assert.equal(sndk?.listings[0].currentlyListed, false);
      assert.equal(isOfficialV1(sndk), false);
      const discrepancies = await repository.sourceDiscrepancies({ chainId: 8453 });
      assert.deepEqual(discrepancies.filter((row) => row.kind === 'delisted_by_source'), [
        {
          kind: 'delisted_by_source',
          tokenAddress: SNDK,
          ticker: 'SNDKc',
          sourceKind: 'base_docs_technical',
          lastSeenAt: '2026-08-25T09:00:00.000Z',
        },
      ]);
    });

    test('how long a source has listed an asset survives the next check', async () => {
      const { repository } = await open();
      await repository.recordSnapshot({ snapshot: snapshotFixtureV1(), assets: [assetFixtureV1()] });
      await repository.recordSnapshot({
        snapshot: snapshotFixtureV1({ observedAt: '2026-08-26T09:00:00.000Z' }),
        assets: [assetFixtureV1({ displayName: 'Apple Inc.' })],
      });
      const identity = await repository.officialIdentity({ chainId: 8453, tokenAddress: AAPL });
      assert.equal(identity?.listings[0].firstSeenAt, '2026-08-25T09:00:00.000Z');
      assert.equal(identity?.listings[0].lastSeenAt, '2026-08-26T09:00:00.000Z');
      assert.equal(identity?.listings[0].displayName, 'Apple Inc.');
    });

    test('a check recorded with a wrong clock does not delist the corpus', async () => {
      const { repository } = await open();
      // Found end to end: a stray snapshot dated ahead of every real check sat
      // permanently newest, and "still listed" -- compared as a timestamp --
      // went false for all thirteen assets on the very next successful check.
      // Current listing is an identity match against the snapshot that wrote
      // the row, so a caller's clock cannot reach it.
      await repository.recordSnapshot({
        snapshot: snapshotFixtureV1({ observedAt: '2027-01-01T00:00:00.000Z' }),
        assets: [assetFixtureV1()],
      });
      const outcome = await repository.recordSnapshot({
        snapshot: snapshotFixtureV1({ observedAt: '2026-08-25T09:00:00.000Z' }),
        assets: [assetFixtureV1()],
      });
      assert.deepEqual(outcome.delisted, []);
      assert.deepEqual(outcome.stillListed, [AAPL]);
      const identity = await repository.officialIdentity({ chainId: 8453, tokenAddress: AAPL });
      assert.equal(identity?.listings[0].currentlyListed, true);
      // And the span it has been listed for does not travel backwards.
      assert.equal(identity?.listings[0].lastSeenAt, '2027-01-01T00:00:00.000Z');
      assert.deepEqual(await repository.sourceDiscrepancies({ chainId: 8453 }), []);
    });

    test('two reviewed sources disagreeing is rendered, not reconciled', async () => {
      const { repository } = await open();
      await repository.recordSnapshot({
        snapshot: snapshotFixtureV1(),
        assets: [assetFixtureV1(), assetFixtureV1({ tokenAddress: SNDK, ticker: 'SNDKc', displayName: null })],
      });
      // Before the product list has ever been read, its silence is our gap.
      assert.deepEqual(await repository.sourceDiscrepancies({ chainId: 8453 }), []);

      await repository.recordSnapshot({
        snapshot: snapshotFixtureV1({
          sourceKind: 'base_product_list',
          sourceUrl: LIST_URL,
          observedAt: '2026-08-25T09:30:00.000Z',
        }),
        assets: [
          assetFixtureV1({ sourceKind: 'base_product_list', referenceFeedAddress: null }),
        ],
      });

      const discrepancies = await repository.sourceDiscrepancies({ chainId: 8453 });
      assert.deepEqual(discrepancies, [
        {
          kind: 'listed_in_one_source',
          tokenAddress: SNDK,
          ticker: 'SNDKc',
          listedIn: ['base_docs_technical'],
          missingFrom: ['base_product_list'],
        },
      ]);

      const identity = await repository.officialIdentity({ chainId: 8453, tokenAddress: AAPL });
      assert.deepEqual(
        identity?.listings.map((listing) => listing.sourceKind),
        ['base_docs_technical', 'base_product_list'],
      );
      // The feed the technical corpus binds is not invented for the source
      // that does not publish one.
      assert.deepEqual(
        identity?.listings.map((listing) => listing.referenceFeedAddress),
        ['0x787f13dea48db0897cbcdd985de77809d837f988', null],
      );
    });

    test('one ticker on two contracts is an alarm, not a merge', async () => {
      const { repository } = await open();
      await repository.recordSnapshot({ snapshot: snapshotFixtureV1(), assets: [assetFixtureV1()] });
      await repository.recordSnapshot({
        snapshot: snapshotFixtureV1({
          sourceKind: 'base_product_list',
          sourceUrl: LIST_URL,
          observedAt: '2026-08-25T09:30:00.000Z',
        }),
        assets: [
          assetFixtureV1({
            sourceKind: 'base_product_list',
            tokenAddress: LOOKALIKE,
            referenceFeedAddress: null,
          }),
        ],
      });
      const discrepancies = await repository.sourceDiscrepancies({ chainId: 8453 });
      assert.deepEqual(
        discrepancies.filter((row) => row.kind === 'ticker_maps_to_multiple_addresses'),
        [{ kind: 'ticker_maps_to_multiple_addresses', ticker: 'AAPLc', tokenAddresses: [AAPL, LOOKALIKE] }],
      );
    });

    test('one source may publish direct and wrapped representations under one display ticker', async () => {
      const { repository } = await open();
      await repository.recordSnapshot({
        snapshot: snapshotFixtureV1({
          sourceKind: 'backed_assets_api',
          sourceUrl: BACKED_URL,
        }),
        assets: [
          assetFixtureV1({
            sourceKind: 'backed_assets_api',
            ticker: 'bNVDA',
            issuer: 'backed',
            referenceFeedAddress: null,
          }),
          assetFixtureV1({
            sourceKind: 'backed_assets_api',
            tokenAddress: LOOKALIKE,
            ticker: 'bNVDA',
            issuer: 'backed',
            referenceFeedAddress: null,
          }),
        ],
      });

      assert.deepEqual(await repository.sourceDiscrepancies({ chainId: 8453 }), []);
      assert.deepEqual(
        (
          await repository.officialAssets({
            chainId: 8453,
            sourceKind: 'backed_assets_api',
            limit: 10,
          })
        ).map((identity) => identity.tokenAddress),
        [AAPL, LOOKALIKE],
      );
    });

    test('the newest successful check is readable apart from the newest check', async () => {
      const { repository } = await open();
      await repository.recordSnapshot({ snapshot: snapshotFixtureV1(), assets: [assetFixtureV1()] });
      await repository.recordSnapshot({
        snapshot: snapshotFixtureV1({
          observedAt: '2026-08-25T10:00:00.000Z',
          status: 'unparsable',
          corpusHash: null,
          detail: 'contract address table not found',
        }),
        assets: [],
      });
      const newest = await repository.latestSnapshot({ sourceKind: 'base_docs_technical' });
      assert.equal(newest?.status, 'unparsable');
      assert.equal(newest?.detail, 'contract address table not found');
      const newestOk = await repository.latestSnapshot({
        sourceKind: 'base_docs_technical',
        successfulOnly: true,
      });
      assert.equal(newestOk?.observedAt, '2026-08-25T09:00:00.000Z');
    });

    test('the official universe is ordered by ticker and bounded', async () => {
      const { repository } = await open();
      await repository.recordSnapshot({
        snapshot: snapshotFixtureV1(),
        assets: [
          assetFixtureV1({ tokenAddress: SNDK, ticker: 'SNDKc', displayName: null }),
          assetFixtureV1(),
        ],
      });
      const page = await repository.officialAssets({ chainId: 8453, limit: 1 });
      assert.deepEqual(
        page.map((identity) => identity.tokenAddress),
        [AAPL],
      );
      const all = await repository.officialAssets({ chainId: 8453, limit: 50 });
      assert.deepEqual(
        all.map((identity) => identity.listings[0].ticker),
        ['AAPLc', 'SNDKc'],
      );
    });
  });
}
