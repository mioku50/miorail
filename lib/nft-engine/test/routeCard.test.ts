import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { hashNftPurchaseIntentV1, type NftPurchaseIntentV1 } from '@mioagent/route-domain';
import {
  NFT_CONTRACT_SAFETY_COPY_V1,
  buildNftAssetRefV1,
  buildNftCandidateV1,
  buildNftEvidenceV1,
  buildNftRouteCardV1,
  nftEvidenceGapsV1,
  scoreNftCandidateV1,
  type NftObservedAssetV1,
  type NftObservedListingV1,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// T65 §4 / §5 — a gap is shown, not filled, and there is no overall number.
// ---------------------------------------------------------------------------

const BUYER = '0x1111111111111111111111111111111111111111' as const;
const COLLECTION = '0x41dc69132cce31fcbf6755c84538ca268520246f';
const SELLER = '0x4efca7cc8058d5acd2bb2ccd2a9430906291cdd6';
const SEAPORT = '0x0000000000000068f116a894984e2db1123eb395';
const NOW = new Date('2026-07-26T12:00:00.000Z');
const HASH = (c: string) => `0x${c.repeat(64)}` as `0x${string}`;

function intent(overrides: Partial<NftPurchaseIntentV1> = {}): NftPurchaseIntentV1 {
  const base = {
    schemaVersion: 'nft-purchase-intent/v1',
    id: 'nft-intent:1',
    tenantId: `eip155:8453:${BUYER}`,
    walletAddress: BUYER,
    chainId: 8453,
    createdAt: '2026-07-26T11:59:00.000Z',
    updatedAt: '2026-07-26T11:59:00.000Z',
    status: 'ready',
    intentHash: HASH('0'),
    goal: 'nft_purchase',
    inputSource: 'slug_and_token',
    collectionSlug: 'dxterminal',
    contractAddress: COLLECTION,
    tokenId: '16668',
    maxSpendWei: '10000000000000000',
    paymentAsset: 'native_eth',
    quantity: 1,
    tokenStandard: 'erc721',
    verificationDepth: 'standard',
    executionRequested: false,
    ...overrides,
  } as NftPurchaseIntentV1;
  return { ...base, intentHash: hashNftPurchaseIntentV1(base) };
}

const observedAsset: NftObservedAssetV1 = {
  contractAddress: COLLECTION,
  tokenId: '16668',
  tokenStandard: 'erc721',
  collectionSlug: 'dxterminal',
  name: 'IzioGh0st',
  imageUrl: 'https://i2c.seadn.io/base/example.png',
  isDisabled: false,
  isNsfw: false,
  requestHash: HASH('a'),
  responseHash: HASH('b'),
  observedAt: '2026-07-26T11:59:50.000Z',
};

const observedListing: NftObservedListingV1 = {
  orderHash: HASH('c'),
  protocolAddress: SEAPORT,
  seller: SELLER,
  contractAddress: COLLECTION,
  tokenId: '16668',
  totalWei: '3580000000000000',
  feeWei: '35800000000000',
  listingStatus: 'active',
  listingExpiresAt: '2026-07-27T11:43:50.000Z',
  restrictedByZone: true,
  requestHash: HASH('d'),
  responseHash: HASH('e'),
  observedAt: '2026-07-26T11:59:50.000Z',
};

function build(overrides: { estimatedGasWei?: string | null; listing?: NftObservedListingV1; intent?: NftPurchaseIntentV1 } = {}) {
  const goal = overrides.intent ?? intent();
  const asset = buildNftAssetRefV1({ observed: observedAsset, imageAllowed: true });
  const candidate = buildNftCandidateV1({
    intent: goal,
    asset,
    listing: overrides.listing ?? observedListing,
    estimatedGasWei: overrides.estimatedGasWei === undefined ? '300000000000000' : overrides.estimatedGasWei,
    now: NOW,
  });
  const evidence = buildNftEvidenceV1({
    intent: goal,
    asset,
    candidateHash: candidate.candidateHash,
    observedAsset,
    observedListing: overrides.listing ?? observedListing,
    now: NOW,
  });
  return { goal, asset, candidate, evidence };
}

describe('remote media is never trusted into the contract', () => {
  test('a blocked image is dropped, not carried forward with a flag', () => {
    const asset = buildNftAssetRefV1({ observed: observedAsset, imageAllowed: false });
    assert.equal(asset.display.imageBlocked, true);
    // A URL that survives is a URL something will eventually load.
    assert.equal(asset.display.imageUrl, null);
    assert.ok(asset.display.imageBlockedReason);
  });

  test("OpenSea's own moderation flags block the media too", () => {
    for (const flags of [{ isDisabled: true }, { isNsfw: true }]) {
      const asset = buildNftAssetRefV1({ observed: { ...observedAsset, ...flags }, imageAllowed: true });
      assert.equal(asset.display.imageBlocked, true, JSON.stringify(flags));
      assert.equal(asset.display.imageUrl, null);
    }
  });

  test('blocking media changes nothing about identity', () => {
    const shown = buildNftAssetRefV1({ observed: observedAsset, imageAllowed: true });
    const blocked = buildNftAssetRefV1({ observed: observedAsset, imageAllowed: false });
    assert.equal(shown.assetHash, blocked.assetHash);
  });
});

describe('a gap is shown, not filled', () => {
  test('with no gas estimate the total cost is null and total_cost is not scored', () => {
    const { goal, candidate, evidence } = build({ estimatedGasWei: null });
    const dimensions = scoreNftCandidateV1({ intent: goal, candidate, evidence, now: NOW });
    const totalCost = dimensions.find((d) => d.dimension === 'total_cost');
    assert.equal(totalCost?.status, 'not_scored');
    assert.equal(totalCost?.score, null);
    // The listing price wearing the word "total" is the lie this refuses.
    assert.equal(totalCost?.notScoredReason, 'insufficient_evidence');

    const card = buildNftRouteCardV1({ intent: goal, asset: build().asset, candidate, evidence, failureReason: null, now: NOW });
    assert.ok(card.ok);
    assert.equal(card.card.totalCostWei, null);
  });

  test('contract safety says the same sentence every time', () => {
    const { goal, candidate, evidence } = build();
    const safety = scoreNftCandidateV1({ intent: goal, candidate, evidence, now: NOW }).find(
      (d) => d.dimension === 'contract_safety',
    );
    assert.equal(safety?.status, 'not_scored');
    assert.equal(safety?.notScoredReason, 'no_approved_source');
    assert.equal(NFT_CONTRACT_SAFETY_COPY_V1, 'Not scored · No approved contract-risk source');
  });

  test('missing evidence is listed rather than omitted', () => {
    const { goal, asset } = build();
    const partial = buildNftEvidenceV1({
      intent: goal,
      asset,
      candidateHash: null,
      observedAsset,
      observedListing: null,
      now: NOW,
    });
    assert.deepEqual(nftEvidenceGapsV1(partial), ['listing_order']);
  });
});

describe('there is no overall number', () => {
  test('scoring returns exactly the four dimensions and nothing to average', () => {
    const { goal, candidate, evidence } = build();
    const dimensions = scoreNftCandidateV1({ intent: goal, candidate, evidence, now: NOW });
    assert.deepEqual(dimensions.map((d) => d.dimension), [
      'total_cost',
      'listing_freshness',
      'route_simplicity',
      'contract_safety',
    ]);
    const card = buildNftRouteCardV1({ intent: goal, asset: build().asset, candidate, evidence, failureReason: null, now: NOW });
    assert.ok(card.ok);
    assert.equal('overallScore' in card.card, false);
    assert.equal('score' in card.card, false);
  });

  test('the recommendation names one venue and claims nothing wider', () => {
    const { goal, candidate, evidence, asset } = build();
    const card = buildNftRouteCardV1({ intent: goal, asset, candidate, evidence, failureReason: null, now: NOW });
    assert.ok(card.ok);
    assert.equal(card.card.recommendation, 'Best active OpenSea listing for this NFT');
  });
});

describe('an unbuyable listing still gets a card', () => {
  test('a cancelled listing produces a failed card carrying the reason', () => {
    const { goal, asset, evidence } = build();
    const cancelled = build({ listing: { ...observedListing, listingStatus: 'cancelled' } });
    const card = buildNftRouteCardV1({
      intent: goal,
      asset,
      candidate: cancelled.candidate,
      evidence,
      failureReason: null,
      now: NOW,
    });
    assert.equal(card.ok, false);
    assert.equal(card.card.status, 'failed');
    assert.equal(card.card.failureReason, 'listing_not_active');
    // No price beside an unbuyable listing — it invites a click that cannot
    // succeed.
    assert.equal(card.card.candidate, null);
    assert.equal(card.card.totalCostWei, null);
  });

  test('a listing above the ceiling is refused with the ceiling as the reason', () => {
    const { goal, asset, candidate, evidence } = build({ intent: intent({ maxSpendWei: '1000000000000000' }) });
    const card = buildNftRouteCardV1({
      intent: intent({ maxSpendWei: '1000000000000000' }),
      asset,
      candidate,
      evidence,
      failureReason: null,
      now: NOW,
    });
    assert.equal(card.ok, false);
    assert.equal(card.card.failureReason, 'price_above_ceiling');
    void goal;
    void evidence;
  });

  test('no listing at all is a card that says so', () => {
    const { goal, asset } = build();
    const card = buildNftRouteCardV1({ intent: goal, asset, candidate: null, evidence: [], failureReason: null, now: NOW });
    assert.equal(card.ok, false);
    assert.equal(card.card.failureReason, 'no_active_listing');
    assert.equal(card.card.status, 'failed');
  });
});

describe('the card is bound to what was observed', () => {
  test('every evidence hash on the card exists in the evidence it was built from', () => {
    const { goal, asset, candidate, evidence } = build();
    const card = buildNftRouteCardV1({ intent: goal, asset, candidate, evidence, failureReason: null, now: NOW });
    assert.ok(card.ok);
    assert.deepEqual(card.card.evidenceHashes, evidence.map((record) => record.evidenceHash));
    assert.equal(card.card.evidenceHashes.length, 4);
  });

  test('evidence records the order, the price and the expiry that were seen', () => {
    const { evidence } = build();
    const order = evidence.find((record) => record.evidenceKind === 'listing_order');
    assert.equal(order?.orderHash, observedListing.orderHash);
    assert.equal(order?.priceWei, '3580000000000000');
    assert.equal(order?.currency, 'native_eth');
    assert.equal(order?.listingExpiresAt, observedListing.listingExpiresAt);
    assert.equal(order?.requestHash, observedListing.requestHash);
    assert.equal(order?.responseHash, observedListing.responseHash);
  });
});
