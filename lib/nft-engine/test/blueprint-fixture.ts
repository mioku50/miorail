import { hashNftPurchaseIntentV1, type NftPurchaseIntentV1 } from '@mioagent/route-domain';
import {
  SEAPORT_FULFILL_ADVANCED_ORDER_SIGNATURE_V1,
  SEAPORT_FULFILL_BASIC_ORDER_SIGNATURE_V1,
  buildNftAssetRefV1,
  buildNftCandidateV1,
  buildNftEvidenceV1,
  buildNftPurchaseBlueprintV1,
  buildNftRouteCardV1,
  readOpenSeaFulfillmentV1,
  type NftObservedAssetV1,
  type NftObservedListingV1,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Shared fixtures. Both payloads are the REAL shapes observed on Base:
// the advanced one from a zone-restricted listing, the basic one from an
// ordinary listing read live on 2026-07-26. Hand-invented structs would let
// the encoders accept shapes OpenSea never sends.
// ---------------------------------------------------------------------------

export const FIX_BUYER = '0x1111111111111111111111111111111111111111' as const;
export const FIX_SELLER = '0x4efca7cc8058d5acd2bb2ccd2a9430906291cdd6';
export const FIX_COLLECTION = '0x41dc69132cce31fcbf6755c84538ca268520246f';
export const FIX_TOKEN_ID = '16668';
export const FIX_SEAPORT = '0x0000000000000068f116a894984e2db1123eb395';
export const FIX_NOW = new Date('2026-07-26T12:00:00.000Z');
/** The listing total: seller share plus the one fee recipient. */
export const FIX_PRICE_WEI = '3580000000000000';
const FIX_SELLER_SHARE = '3544200000000000';
const FIX_FEE = '35800000000000';
const FIX_FEE_RECIPIENT = '0x0000a26b00c1f0df003000390027140000faa719';

const H = (c: string) => `0x${c.repeat(64)}` as `0x${string}`;

const ADVANCED_PARAMETERS = {
  offerer: FIX_SELLER,
  zone: '0x000056f7000000ece9003ca63978907a00ffd100',
  offer: [{ itemType: 2, token: FIX_COLLECTION, identifierOrCriteria: FIX_TOKEN_ID, startAmount: '1', endAmount: '1' }],
  consideration: [
    { itemType: 0, token: '0x0000000000000000000000000000000000000000', identifierOrCriteria: '0', startAmount: FIX_SELLER_SHARE, endAmount: FIX_SELLER_SHARE, recipient: FIX_SELLER },
    { itemType: 0, token: '0x0000000000000000000000000000000000000000', identifierOrCriteria: '0', startAmount: FIX_FEE, endAmount: FIX_FEE, recipient: FIX_FEE_RECIPIENT },
  ],
  orderType: 3,
  startTime: '1785066231',
  endTime: '1785152630',
  zoneHash: H('0'),
  salt: '0',
  conduitKey: '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000',
  totalOriginalConsiderationItems: 2,
};

/** The live BasicOrderParameters shape, field for field. */
export const BASIC_PARAMETERS_V1 = {
  considerationToken: '0x0000000000000000000000000000000000000000',
  considerationIdentifier: '0',
  considerationAmount: FIX_SELLER_SHARE,
  offerer: FIX_SELLER,
  zone: '0x0000000000000000000000000000000000000000',
  offerToken: FIX_COLLECTION,
  offerIdentifier: FIX_TOKEN_ID,
  offerAmount: '1',
  basicOrderType: 0,
  startTime: '1785066231',
  endTime: '99999999999',
  zoneHash: H('0'),
  salt: '27855337018906766782546881864045825683096516384821792734233899910293539019922',
  offererConduitKey: '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000',
  fulfillerConduitKey: '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000',
  totalOriginalAdditionalRecipients: '1',
  additionalRecipients: [{ amount: FIX_FEE, recipient: FIX_FEE_RECIPIENT }],
  signature: '0x863c5243958c70a4fefb4bcabe544357491cf6c808502b45fc951f3218e21186fa3ec16b64e46f58bb221e9ba4f598bddee45e9276c7948c9f2f71706e5abe31c',
};

export function basicPayloadV1(
  paramOverrides: Record<string, unknown> = {},
  txOverrides: Record<string, unknown> = {},
) {
  return {
    protocol: 'seaport1.6',
    fulfillment_data: {
      transaction: {
        function: SEAPORT_FULFILL_BASIC_ORDER_SIGNATURE_V1,
        chain: 8453,
        to: FIX_SEAPORT,
        value: FIX_PRICE_WEI,
        calldata_suffix: '0x1234abcd',
        input_data: { parameters: { ...BASIC_PARAMETERS_V1, ...paramOverrides } },
        ...txOverrides,
      },
      orders: [],
    },
  };
}

export function advancedPayloadV1(
  txOverrides: Record<string, unknown> = {},
  inputOverrides: Record<string, unknown> = {},
) {
  return {
    protocol: 'seaport1.6',
    fulfillment_data: {
      transaction: {
        function: SEAPORT_FULFILL_ADVANCED_ORDER_SIGNATURE_V1,
        chain: 8453,
        to: FIX_SEAPORT,
        value: FIX_PRICE_WEI,
        calldata_suffix: '0x1234abcd',
        input_data: {
          advancedOrder: { parameters: ADVANCED_PARAMETERS, numerator: '1', denominator: '1', signature: '0x', extraData: '0x' },
          criteriaResolvers: [],
          fulfillerConduitKey: H('0'),
          recipient: FIX_BUYER,
          ...inputOverrides,
        },
        ...txOverrides,
      },
      orders: [],
    },
  };
}

const OBSERVED_ASSET: NftObservedAssetV1 = {
  contractAddress: FIX_COLLECTION,
  tokenId: FIX_TOKEN_ID,
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

export function observedListingV1(restrictedByZone: boolean): NftObservedListingV1 {
  return {
    orderHash: H('c'),
    protocolAddress: FIX_SEAPORT,
    seller: FIX_SELLER,
    contractAddress: FIX_COLLECTION,
    tokenId: FIX_TOKEN_ID,
    totalWei: FIX_PRICE_WEI,
    feeWei: FIX_FEE,
    listingStatus: 'active',
    listingExpiresAt: '2026-07-27T11:43:50.000Z',
    restrictedByZone,
    requestHash: H('d'),
    responseHash: H('e'),
    observedAt: '2026-07-26T11:59:50.000Z',
  };
}

export function intentFixtureV1(maxSpendWei = '10000000000000000'): NftPurchaseIntentV1 {
  const iso = '2026-07-26T11:59:00.000Z';
  const base = {
    schemaVersion: 'nft-purchase-intent/v1',
    id: 'nft-intent:fixture',
    tenantId: `eip155:8453:${FIX_BUYER}`,
    walletAddress: FIX_BUYER,
    chainId: 8453,
    createdAt: iso,
    updatedAt: iso,
    status: 'ready',
    intentHash: H('0'),
    goal: 'nft_purchase',
    inputSource: 'contract_and_token',
    collectionSlug: 'dxterminal',
    contractAddress: FIX_COLLECTION,
    tokenId: FIX_TOKEN_ID,
    maxSpendWei,
    paymentAsset: 'native_eth',
    quantity: 1,
    tokenStandard: 'erc721',
    verificationDepth: 'standard',
    executionRequested: false,
  } as NftPurchaseIntentV1;
  return { ...base, intentHash: hashNftPurchaseIntentV1(base) };
}

/** The full graph up to a Blueprint. `form` picks which real payload the
 * calldata is encoded from. */
export function blueprintFixtureV1(form: 'basic' | 'advanced' = 'advanced') {
  const intent = intentFixtureV1();
  const asset = buildNftAssetRefV1({ observed: OBSERVED_ASSET, imageAllowed: true });
  const candidate = buildNftCandidateV1({
    intent,
    asset,
    listing: observedListingV1(form === 'advanced'),
    estimatedGasWei: '300000000000000',
    now: FIX_NOW,
  });
  const evidence = buildNftEvidenceV1({
    intent,
    asset,
    candidateHash: candidate.candidateHash,
    observedAsset: OBSERVED_ASSET,
    observedListing: observedListingV1(form === 'advanced'),
    now: FIX_NOW,
  });
  const built = buildNftRouteCardV1({ intent, asset, candidate, evidence, failureReason: null, now: FIX_NOW });
  const read = readOpenSeaFulfillmentV1({
    payload: form === 'basic' ? basicPayloadV1() : advancedPayloadV1(),
    candidate,
    buyer: FIX_BUYER,
    expectedForm: form,
    now: FIX_NOW,
  });
  if (!read.ok) throw new Error(`fixture fulfillment failed: ${read.reason}`);
  const blueprint = buildNftPurchaseBlueprintV1({
    intent,
    card: built.card,
    candidate,
    fulfillment: read.fulfillment,
    now: FIX_NOW,
  });
  return { intent, asset, candidate, evidence, card: built.card, fulfillment: read.fulfillment, blueprint };
}
