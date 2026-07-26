import {
  hashNftPurchaseIntentV1,
  type NftEvidenceRecordV1,
  type NftListingCandidateV1,
  type NftPurchaseBlueprintV1,
  type NftPurchaseIntentV1,
  type NftPurchaseProofV1,
  type NftRouteCardV1,
} from '@mioagent/route-domain';
import {
  SEAPORT_FULFILL_ADVANCED_ORDER_SIGNATURE_V1,
  buildNftAssetRefV1,
  buildNftCandidateV1,
  buildNftEvidenceV1,
  buildNftOwnershipReadV1,
  buildNftPurchaseBlueprintV1,
  buildNftPurchaseProofV1,
  buildNftReceiptLegV1,
  buildNftRouteCardV1,
  findNftTransferV1,
  readOpenSeaFulfillmentV1,
  type NftObservedAssetV1,
  type NftObservedListingV1,
  type NftReceiptLogV1,
} from '@mioagent/nft-engine';
import { ERC721_TRANSFER_TOPIC_V1 } from '@mioagent/nft-engine';

// T65.1 §1 — one real NFT purchase graph, built by the engine that will build
// it in production. Fixtures assembled by hand would let the storage layer
// accept shapes the engine never produces.

export const NFT_BUYER = '0x1111111111111111111111111111111111111111' as const;
export const NFT_TENANT = `eip155:8453:${NFT_BUYER}`;
export const NFT_OTHER_TENANT = 'eip155:8453:0x2222222222222222222222222222222222222222';
export const NFT_SELLER = '0x4efca7cc8058d5acd2bb2ccd2a9430906291cdd6';
export const NFT_COLLECTION = '0x41dc69132cce31fcbf6755c84538ca268520246f';
export const NFT_TOKEN_ID = '16668';
const SEAPORT = '0x0000000000000068f116a894984e2db1123eb395';
export const NFT_NOW = new Date('2026-07-26T12:00:00.000Z');

const H = (c: string) => `0x${c.repeat(64)}` as `0x${string}`;
export const NFT_TX_HASH = H('f');

const PARAMETERS = {
  offerer: NFT_SELLER,
  zone: '0x000056f7000000ece9003ca63978907a00ffd100',
  offer: [
    { itemType: 2, token: NFT_COLLECTION, identifierOrCriteria: NFT_TOKEN_ID, startAmount: '1', endAmount: '1' },
  ],
  consideration: [
    {
      itemType: 0,
      token: '0x0000000000000000000000000000000000000000',
      identifierOrCriteria: '0',
      startAmount: '3544200000000000',
      endAmount: '3544200000000000',
      recipient: NFT_SELLER,
    },
    {
      itemType: 0,
      token: '0x0000000000000000000000000000000000000000',
      identifierOrCriteria: '0',
      startAmount: '35800000000000',
      endAmount: '35800000000000',
      recipient: '0x0000a26b00c1f0df003000390027140000faa719',
    },
  ],
  orderType: 3,
  startTime: '1785066231',
  endTime: '1785152630',
  zoneHash: H('0'),
  salt: '0',
  conduitKey: '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000',
  totalOriginalConsiderationItems: 2,
};

const FULFILLMENT_PAYLOAD = {
  protocol: 'seaport1.6',
  fulfillment_data: {
    transaction: {
      function: SEAPORT_FULFILL_ADVANCED_ORDER_SIGNATURE_V1,
      chain: 8453,
      to: SEAPORT,
      value: '3580000000000000',
      input_data: {
        advancedOrder: {
          parameters: PARAMETERS,
          numerator: '1',
          denominator: '1',
          signature: '0x',
          extraData: '0x',
        },
        criteriaResolvers: [],
        fulfillerConduitKey: H('0'),
        recipient: NFT_BUYER,
      },
    },
    orders: [],
  },
};

const OBSERVED_ASSET: NftObservedAssetV1 = {
  contractAddress: NFT_COLLECTION,
  tokenId: NFT_TOKEN_ID,
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

const OBSERVED_LISTING: NftObservedListingV1 = {
  orderHash: H('c'),
  protocolAddress: SEAPORT,
  seller: NFT_SELLER,
  contractAddress: NFT_COLLECTION,
  tokenId: NFT_TOKEN_ID,
  totalWei: '3580000000000000',
  feeWei: '35800000000000',
  listingStatus: 'active',
  listingExpiresAt: '2026-07-27T11:43:50.000Z',
  restrictedByZone: true,
  requestHash: H('d'),
  responseHash: H('e'),
  observedAt: '2026-07-26T11:59:50.000Z',
};

export function nftIntentFixture(
  tenantId = NFT_TENANT,
  id = 'nft-intent:test',
  maxSpendWei = '10000000000000000',
): NftPurchaseIntentV1 {
  const iso = '2026-07-26T11:59:00.000Z';
  const base = {
    schemaVersion: 'nft-purchase-intent/v1',
    id,
    tenantId,
    walletAddress: NFT_BUYER,
    chainId: 8453,
    createdAt: iso,
    updatedAt: iso,
    status: 'ready',
    intentHash: H('0'),
    goal: 'nft_purchase',
    inputSource: 'contract_and_token',
    collectionSlug: 'dxterminal',
    contractAddress: NFT_COLLECTION,
    tokenId: NFT_TOKEN_ID,
    maxSpendWei,
    paymentAsset: 'native_eth',
    quantity: 1,
    tokenStandard: 'erc721',
    verificationDepth: 'standard',
    executionRequested: false,
  } as NftPurchaseIntentV1;
  return { ...base, intentHash: hashNftPurchaseIntentV1(base) };
}

export interface NftFixtureGraph {
  intent: NftPurchaseIntentV1;
  candidate: NftListingCandidateV1;
  evidence: NftEvidenceRecordV1[];
  card: NftRouteCardV1;
  blueprint: NftPurchaseBlueprintV1;
}

export function nftFixtureGraph(intent: NftPurchaseIntentV1 = nftIntentFixture()): NftFixtureGraph {
  const asset = buildNftAssetRefV1({ observed: OBSERVED_ASSET, imageAllowed: true });
  const candidate = buildNftCandidateV1({
    intent,
    asset,
    listing: OBSERVED_LISTING,
    estimatedGasWei: '300000000000000',
    now: NFT_NOW,
  });
  const evidence = buildNftEvidenceV1({
    intent,
    asset,
    candidateHash: candidate.candidateHash,
    observedAsset: OBSERVED_ASSET,
    observedListing: OBSERVED_LISTING,
    now: NFT_NOW,
  });
  const built = buildNftRouteCardV1({
    intent,
    asset,
    candidate,
    evidence,
    failureReason: null,
    now: NFT_NOW,
  });
  const fulfillment = readOpenSeaFulfillmentV1({
    payload: FULFILLMENT_PAYLOAD,
    candidate,
    buyer: NFT_BUYER,
  });
  if (!fulfillment.ok) throw new Error(`fixture fulfillment failed: ${fulfillment.reason}`);
  const blueprint = buildNftPurchaseBlueprintV1({
    intent,
    card: built.card,
    candidate,
    fulfillment: fulfillment.fulfillment,
    now: NFT_NOW,
  });
  return { intent, candidate, evidence, card: built.card, blueprint };
}

function topic(address: string): string {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
}
function uint(value: bigint): string {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

function transferLog(to: string): NftReceiptLogV1 {
  return {
    address: NFT_COLLECTION,
    topics: [ERC721_TRANSFER_TOPIC_V1, topic(NFT_SELLER), topic(to), uint(BigInt(NFT_TOKEN_ID))],
    data: '0x',
  };
}

/** A proof at whichever stage the test needs. `submitted` is the state right
 * after the wallet returned a hash: known transaction, nothing confirmed. */
export function nftProofFixture(
  blueprint: NftPurchaseBlueprintV1,
  stage: 'submitted' | 'completed' | 'reconciliation_required',
  now: Date = NFT_NOW,
): NftPurchaseProofV1 {
  const asset = blueprint.asset;
  const common = { blueprint, asset, seller: NFT_SELLER, now };
  if (stage === 'submitted') {
    return buildNftPurchaseProofV1({
      ...common,
      receipt: buildNftReceiptLegV1({
        receipt: null,
        actualNativeValueWei: null,
        submittedTransactionHash: NFT_TX_HASH,
      }),
      transfer: findNftTransferV1({
        logs: [],
        contractAddress: NFT_COLLECTION,
        tokenId: NFT_TOKEN_ID,
        buyer: NFT_BUYER,
      }),
      ownership: buildNftOwnershipReadV1({
        owner: null,
        buyer: NFT_BUYER,
        blockNumber: null,
        observedAt: null,
        unavailableReason: 'The transaction has not been mined yet.',
      }),
    });
  }
  const receipt = buildNftReceiptLegV1({
    receipt: {
      status: 'success',
      transactionHash: NFT_TX_HASH,
      blockNumber: 30_000_000n,
      gasUsed: 210_000n,
      logs: [],
    },
    actualNativeValueWei: '3580000000000000',
  });
  if (stage === 'reconciliation_required') {
    // Succeeded, and nothing yet says the token arrived.
    return buildNftPurchaseProofV1({
      ...common,
      receipt,
      transfer: findNftTransferV1({
        logs: [],
        contractAddress: NFT_COLLECTION,
        tokenId: NFT_TOKEN_ID,
        buyer: NFT_BUYER,
      }),
      ownership: buildNftOwnershipReadV1({
        owner: null,
        buyer: NFT_BUYER,
        blockNumber: null,
        observedAt: null,
        unavailableReason: 'The ownership read did not answer.',
      }),
    });
  }
  return buildNftPurchaseProofV1({
    ...common,
    receipt,
    transfer: findNftTransferV1({
      logs: [transferLog(NFT_BUYER)],
      contractAddress: NFT_COLLECTION,
      tokenId: NFT_TOKEN_ID,
      buyer: NFT_BUYER,
    }),
    ownership: buildNftOwnershipReadV1({
      owner: NFT_BUYER,
      buyer: NFT_BUYER,
      blockNumber: 30_000_001n,
      observedAt: now,
    }),
  });
}
