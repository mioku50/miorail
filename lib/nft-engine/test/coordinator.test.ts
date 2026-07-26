import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { hashNftPurchaseIntentV1, type NftPurchaseIntentV1 } from '@mioagent/route-domain';
import {
  compareNftRoutesV1,
  nftComparisonCopyV1,
  type NftGatewayResultV1,
  type NftObservedAssetV1,
  type NftObservedListingV1,
  type OpenSeaGatewayV1,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// T65.1 §2 — the comparison, with the network replaced by a fake.
//
// A global fetch detonator would be redundant here: the gateway is the only
// way out and it is injected. What these tests hold in place is that every
// failure still produces a CARD, and that no failure produces a candidate.
// ---------------------------------------------------------------------------

const BUYER = '0x1111111111111111111111111111111111111111' as const;
const SELLER = '0x4efca7cc8058d5acd2bb2ccd2a9430906291cdd6';
const COLLECTION = '0x41dc69132cce31fcbf6755c84538ca268520246f';
const SEAPORT = '0x0000000000000068f116a894984e2db1123eb395';
const NOW = new Date('2026-07-26T12:00:00.000Z');
const H = (c: string) => `0x${c.repeat(64)}` as `0x${string}`;

const ASSET: NftObservedAssetV1 = {
  contractAddress: COLLECTION,
  tokenId: '16668',
  tokenStandard: 'erc721',
  collectionSlug: 'dxterminal',
  name: 'IzioGh0st',
  imageUrl: 'https://i2c.seadn.io/base/ok.png',
  isDisabled: false,
  isNsfw: false,
  requestHash: H('a'),
  responseHash: H('b'),
  observedAt: '2026-07-26T11:59:50.000Z',
};

const LISTING: NftObservedListingV1 = {
  orderHash: H('c'),
  protocolAddress: SEAPORT,
  seller: SELLER,
  contractAddress: COLLECTION,
  tokenId: '16668',
  totalWei: '3580000000000000',
  feeWei: '35800000000000',
  listingStatus: 'active',
  listingExpiresAt: '2026-07-27T11:43:50.000Z',
  restrictedByZone: true,
  requestHash: H('d'),
  responseHash: H('e'),
  observedAt: '2026-07-26T11:59:50.000Z',
};

function intent(maxSpendWei = '10000000000000000'): NftPurchaseIntentV1 {
  const iso = '2026-07-26T11:59:00.000Z';
  const base = {
    schemaVersion: 'nft-purchase-intent/v1',
    id: 'nft-intent:test',
    tenantId: `eip155:8453:${BUYER}`,
    walletAddress: BUYER,
    chainId: 8453,
    createdAt: iso,
    updatedAt: iso,
    status: 'ready',
    intentHash: H('0'),
    goal: 'nft_purchase',
    inputSource: 'contract_and_token',
    collectionSlug: 'dxterminal',
    contractAddress: COLLECTION,
    tokenId: '16668',
    maxSpendWei,
    paymentAsset: 'native_eth',
    quantity: 1,
    tokenStandard: 'erc721',
    verificationDepth: 'standard',
    executionRequested: false,
  } as NftPurchaseIntentV1;
  return { ...base, intentHash: hashNftPurchaseIntentV1(base) };
}

function gateway(overrides: Partial<OpenSeaGatewayV1> = {}): OpenSeaGatewayV1 {
  const ok = <T>(value: T): NftGatewayResultV1<T> => ({ ok: true, value });
  return {
    async readNft() {
      return ok(ASSET);
    },
    async readContract() {
      return ok({ address: COLLECTION, collectionSlug: 'dxterminal', standard: 'erc721' });
    },
    async readBestListing() {
      return ok(LISTING);
    },
    async readOrder() {
      return ok(LISTING);
    },
    ...overrides,
  };
}

describe('a listing that can be bought', () => {
  test('produces a card, a candidate and its evidence', async () => {
    const result = await compareNftRoutesV1(
      { gateway: gateway() },
      { intent: intent(), now: NOW, estimatedGasWei: '300000000000000' },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.card.status, 'ready');
    assert.equal(result.candidate.listingPriceWei, '3580000000000000');
    assert.equal(result.card.recommendation, 'Best active OpenSea listing for this NFT');
    assert.ok(result.evidence.length > 0);
    // Four dimensions, and no combined number to read as a market verdict.
    assert.equal(result.card.dimensions.length, 4);
    assert.equal('overallScore' in result.card, false);
  });

  test('the media policy decides, not the response', async () => {
    const withImage = await compareNftRoutesV1(
      { gateway: gateway() },
      { intent: intent(), now: NOW, imageAllowed: true },
    );
    const without = await compareNftRoutesV1({ gateway: gateway() }, { intent: intent(), now: NOW });
    assert.equal(withImage.asset?.display.imageUrl, 'https://i2c.seadn.io/base/ok.png');
    // A blocked image is not carried at all — a URL that survives is a URL
    // something eventually loads.
    assert.equal(without.asset?.display.imageUrl, null);
    assert.equal(without.asset?.display.imageBlocked, true);
  });

  test('without a gas estimate there is no total, not a price wearing the word', async () => {
    const result = await compareNftRoutesV1({ gateway: gateway() }, { intent: intent(), now: NOW });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.card.totalCostWei, null);
  });
});

describe('every failure still says what happened', () => {
  test('an unlisted NFT gets a card naming the token', async () => {
    const result = await compareNftRoutesV1(
      { gateway: gateway({ async readBestListing() { return { ok: false, reason: 'not_found' }; } }) },
      { intent: intent(), now: NOW },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'no_active_listing');
    assert.equal(result.card?.status, 'failed');
    assert.equal(result.card?.candidate, null);
    assert.equal(result.card?.asset.tokenId, '16668');
    assert.match(result.card?.failureReason ?? '', /not listed for sale/);
  });

  test('a listing above the ceiling is refused and says so', async () => {
    const result = await compareNftRoutesV1(
      { gateway: gateway() },
      { intent: intent('1000000000000000'), now: NOW },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'price_above_ceiling');
    assert.equal(result.card?.status, 'failed');
    // The card carries no price for a purchase that is not on offer.
    assert.equal(result.card?.candidate, null);
  });

  test('a provider outage is not phrased as a missing NFT', async () => {
    const result = await compareNftRoutesV1(
      { gateway: gateway({ async readNft() { return { ok: false, reason: 'provider_unavailable' }; } }) },
      { intent: intent(), now: NOW },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'provider_unavailable');
    assert.equal(result.card, null);
    assert.match(nftComparisonCopyV1('provider_unavailable'), /did not answer/);
    assert.equal(/does not exist/.test(nftComparisonCopyV1('provider_unavailable')), false);
  });

  test('a different token in the response is a mismatch, never a substitution', async () => {
    const result = await compareNftRoutesV1(
      {
        gateway: gateway({
          async readNft() {
            return { ok: true, value: { ...ASSET, tokenId: '99999' } };
          },
        }),
      },
      { intent: intent(), now: NOW },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'asset_mismatch');
  });

  test('an ERC-1155 is refused before anything is priced', async () => {
    const result = await compareNftRoutesV1(
      {
        gateway: gateway({
          async readNft() {
            return { ok: false, reason: 'standard_unsupported' };
          },
        }),
      },
      { intent: intent(), now: NOW },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'standard_unsupported');
  });

  test('a listing endpoint with no slug to ask is an incomplete order, not "unlisted"', async () => {
    const result = await compareNftRoutesV1(
      {
        gateway: gateway({
          async readNft() {
            return { ok: true, value: { ...ASSET, collectionSlug: null } };
          },
        }),
      },
      { intent: intent(), now: NOW },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    // Nobody looked. Saying "not listed" would report a fact never checked.
    assert.equal(result.reason, 'order_incomplete');
  });
});
