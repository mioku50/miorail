import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { hashNftPurchaseIntentV1, type NftPurchaseIntentV1 } from '@mioagent/route-domain';
import {
  SEAPORT_FULFILL_ADVANCED_ORDER_SIGNATURE_V1,
  buildNftAssetRefV1,
  buildNftCandidateV1,
  readOpenSeaFulfillmentV1,
  type NftObservedAssetV1,
  type NftObservedListingV1,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// T65 §6 — the bytes are encoded here, from an ABI pinned here.
//
// The payload below is the real 2026-07-26 shape from
// POST /api/v2/listings/fulfillment_data, trimmed to the fields the encoder
// reads. Running it live on the VPS produced selector 0xe7acab24
// (fulfillAdvancedOrder) and a value equal to the card's, which is what these
// tests hold in place.
// ---------------------------------------------------------------------------

const BUYER = '0x1111111111111111111111111111111111111111' as const;
const SELLER = '0x4efca7cc8058d5acd2bb2ccd2a9430906291cdd6';
const COLLECTION = '0x41dc69132cce31fcbf6755c84538ca268520246f';
const SEAPORT = '0x0000000000000068f116a894984e2db1123eb395';
const NOW = new Date('2026-07-26T12:00:00.000Z');
const H = (c: string) => `0x${c.repeat(64)}` as `0x${string}`;

const PARAMETERS = {
  offerer: SELLER,
  zone: '0x000056f7000000ece9003ca63978907a00ffd100',
  offer: [{ itemType: 2, token: COLLECTION, identifierOrCriteria: '16668', startAmount: '1', endAmount: '1' }],
  consideration: [
    { itemType: 0, token: '0x0000000000000000000000000000000000000000', identifierOrCriteria: '0', startAmount: '3544200000000000', endAmount: '3544200000000000', recipient: SELLER },
    { itemType: 0, token: '0x0000000000000000000000000000000000000000', identifierOrCriteria: '0', startAmount: '35800000000000', endAmount: '35800000000000', recipient: '0x0000a26b00c1f0df003000390027140000faa719' },
  ],
  orderType: 3,
  startTime: '1785066231',
  endTime: '1785152630',
  zoneHash: H('0'),
  salt: '0',
  conduitKey: '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000',
  totalOriginalConsiderationItems: 2,
};

function payload(overrides: Record<string, unknown> = {}, inputOverrides: Record<string, unknown> = {}) {
  return {
    protocol: 'seaport1.6',
    fulfillment_data: {
      transaction: {
        function: SEAPORT_FULFILL_ADVANCED_ORDER_SIGNATURE_V1,
        chain: 8453,
        to: SEAPORT,
        value: '3580000000000000',
        // OpenSea's attribution tag. Present in the real response and
        // deliberately never appended to the calldata we ask anyone to sign.
        calldata_suffix: '0x1234abcd',
        input_data: {
          advancedOrder: { parameters: PARAMETERS, numerator: '1', denominator: '1', signature: '0x', extraData: '0x' },
          criteriaResolvers: [],
          fulfillerConduitKey: H('0'),
          recipient: BUYER,
          ...inputOverrides,
        },
        ...overrides,
      },
      orders: [],
    },
  };
}

const observedAsset: NftObservedAssetV1 = {
  contractAddress: COLLECTION,
  tokenId: '16668',
  tokenStandard: 'erc721',
  collectionSlug: 'dxterminal',
  name: 'IzioGh0st',
  imageUrl: null,
  isDisabled: false,
  isNsfw: false,
  requestHash: H('a'),
  responseHash: H('b'),
  observedAt: '2026-07-26T11:59:50.000Z',
};

const observedListing: NftObservedListingV1 = {
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

function fixture() {
  const base = {
    schemaVersion: 'nft-purchase-intent/v1',
    id: 'nft-intent:1',
    tenantId: `eip155:8453:${BUYER}`,
    walletAddress: BUYER,
    chainId: 8453,
    createdAt: '2026-07-26T11:59:00.000Z',
    updatedAt: '2026-07-26T11:59:00.000Z',
    status: 'ready',
    intentHash: H('0'),
    goal: 'nft_purchase',
    inputSource: 'contract_and_token',
    collectionSlug: 'dxterminal',
    contractAddress: COLLECTION,
    tokenId: '16668',
    maxSpendWei: '10000000000000000',
    paymentAsset: 'native_eth',
    quantity: 1,
    tokenStandard: 'erc721',
    verificationDepth: 'standard',
    executionRequested: false,
  } as NftPurchaseIntentV1;
  const intent = { ...base, intentHash: hashNftPurchaseIntentV1(base) };
  const asset = buildNftAssetRefV1({ observed: observedAsset, imageAllowed: true });
  const candidate = buildNftCandidateV1({ intent, asset, listing: observedListing, estimatedGasWei: '300000000000000', now: NOW });
  return { intent, asset, candidate };
}

describe('the calldata is produced here, not received', () => {
  test('the real fulfillment shape encodes to fulfillAdvancedOrder', () => {
    const { candidate } = fixture();
    const result = readOpenSeaFulfillmentV1({ payload: payload(), candidate, buyer: BUYER });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // Confirmed live on the VPS against the real listing.
    assert.equal(result.fulfillment.data.slice(0, 10), '0xe7acab24');
    assert.equal(result.fulfillment.to, SEAPORT);
    assert.equal(result.fulfillment.valueWei, candidate.listingPriceWei);
    assert.equal(result.fulfillment.recipient, BUYER);
  });

  test("OpenSea's calldata suffix is never appended", () => {
    const { candidate } = fixture();
    const result = readOpenSeaFulfillmentV1({ payload: payload(), candidate, buyer: BUYER });
    assert.ok(result.ok);
    // Trailing bytes on a call we ask someone to sign are bytes nobody here
    // verified.
    assert.equal(result.fulfillment.data.endsWith('1234abcd'), false);
  });

  test('the encoding is deterministic — the same response gives the same bytes', () => {
    const { candidate } = fixture();
    const a = readOpenSeaFulfillmentV1({ payload: payload(), candidate, buyer: BUYER });
    const b = readOpenSeaFulfillmentV1({ payload: payload(), candidate, buyer: BUYER });
    assert.ok(a.ok && b.ok);
    assert.equal(a.fulfillment.data, b.fulfillment.data);
    assert.equal(a.fulfillment.responseHash, b.fulfillment.responseHash);
  });
});

describe('the response does not get to choose', () => {
  test('another function is refused, not encoded', () => {
    const { candidate } = fixture();
    const result = readOpenSeaFulfillmentV1({
      payload: payload({ function: 'transferFrom(address,address,uint256)' }),
      candidate,
      buyer: BUYER,
    });
    // A provider that picks the function picks the behaviour.
    assert.equal(result.ok === false && result.reason, 'function_not_pinned');
  });

  test('another chain is refused', () => {
    const { candidate } = fixture();
    const result = readOpenSeaFulfillmentV1({ payload: payload({ chain: 1 }), candidate, buyer: BUYER });
    assert.equal(result.ok === false && result.reason, 'chain_mismatch');
  });

  test('another target is refused', () => {
    const { candidate } = fixture();
    const result = readOpenSeaFulfillmentV1({
      payload: payload({ to: '0x5555555555555555555555555555555555555555' }),
      candidate,
      buyer: BUYER,
    });
    assert.equal(result.ok === false && result.reason, 'target_not_seaport');
  });

  test('a value that is not the reviewed price is refused, higher or lower', () => {
    const { candidate } = fixture();
    for (const value of ['9000000000000000', '1000000000000000']) {
      const result = readOpenSeaFulfillmentV1({ payload: payload({ value }), candidate, buyer: BUYER });
      assert.equal(result.ok === false && result.reason, 'value_mismatch', value);
    }
  });

  test('the NFT going anywhere but the buyer is refused', () => {
    const { candidate } = fixture();
    const result = readOpenSeaFulfillmentV1({
      payload: payload({}, { recipient: SELLER }),
      candidate,
      buyer: BUYER,
    });
    assert.equal(result.ok === false && result.reason, 'recipient_mismatch');
  });

  test('a fulfillment for a different token is refused', () => {
    const { candidate } = fixture();
    const swapped = payload({}, {
      advancedOrder: {
        parameters: { ...PARAMETERS, offer: [{ ...PARAMETERS.offer[0], identifierOrCriteria: '99999' }] },
        numerator: '1',
        denominator: '1',
        signature: '0x',
        extraData: '0x',
      },
    });
    const result = readOpenSeaFulfillmentV1({ payload: swapped, candidate, buyer: BUYER });
    assert.equal(result.ok === false && result.reason, 'order_mismatch');
  });

  test('a criteria resolver is refused — V1 buys one identified token', () => {
    const { candidate } = fixture();
    const result = readOpenSeaFulfillmentV1({
      payload: payload({}, { criteriaResolvers: [{ orderIndex: 0, side: 0, index: 0, identifier: '1', criteriaProof: [] }] }),
      candidate,
      buyer: BUYER,
    });
    assert.equal(result.ok === false && result.reason, 'criteria_resolvers_present');
  });

  test('a partial fill is refused — one ERC-721 is indivisible', () => {
    const { candidate } = fixture();
    const result = readOpenSeaFulfillmentV1({
      payload: payload({}, {
        advancedOrder: { parameters: PARAMETERS, numerator: '1', denominator: '2', signature: '0x', extraData: '0x' },
      }),
      candidate,
      buyer: BUYER,
    });
    assert.equal(result.ok === false && result.reason, 'partial_fill_requested');
  });

  test('a missing or malformed fulfillment is refused rather than half-read', () => {
    const { candidate } = fixture();
    for (const bad of [null, {}, { fulfillment_data: {} }]) {
      const result = readOpenSeaFulfillmentV1({ payload: bad, candidate, buyer: BUYER });
      assert.equal(result.ok === false && result.reason, 'malformed_fulfillment');
    }
  });
});
