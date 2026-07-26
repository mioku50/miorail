import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  NFT_RECOMMENDATION_COPY_V1,
  NftAssetRefV1Schema,
  NftPurchaseProofV1Schema,
  deriveNftProofFinalStatusV1,
  hashNftAssetRefV1,
  sameNftAssetV1,
  type NftAssetRefV1,
  type NftOwnershipReadV1,
  type NftReceiptLegV1,
  type NftTransferLegV1,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// T65 §2 / §9 — the three rules the NFT contracts exist to hold.
// ---------------------------------------------------------------------------

const BUYER = '0x1111111111111111111111111111111111111111';
const SELLER = '0x2222222222222222222222222222222222222222';
const CONTRACT = '0x3333333333333333333333333333333333333333';

function asset(overrides: Partial<NftAssetRefV1> = {}): NftAssetRefV1 {
  const base = {
    schemaVersion: 'nft-asset-ref/v1' as const,
    assetHash: `0x${'0'.repeat(64)}`,
    chain: 'eip155:8453' as const,
    contractAddress: CONTRACT as `0x${string}`,
    tokenId: '123',
    tokenStandard: 'erc721' as const,
    collectionSlug: 'basepaint',
    display: {
      name: 'BasePaint #123',
      collectionName: 'BasePaint',
      imageUrl: 'https://example.invalid/1.png',
      imageBlocked: false,
      imageBlockedReason: null,
    },
    ...overrides,
  } as NftAssetRefV1;
  return { ...base, assetHash: hashNftAssetRefV1(base) };
}

describe('identity is chain + contract + tokenId, never metadata', () => {
  test('a renamed token with new media is still the same token', () => {
    const original = asset();
    const renamed = asset({
      collectionSlug: 'basepaint-v2',
      display: {
        name: 'Something Else Entirely',
        collectionName: 'Not BasePaint',
        imageUrl: null,
        imageBlocked: true,
        imageBlockedReason: 'media failed the image policy',
      },
    });
    assert.equal(sameNftAssetV1(original, renamed), true);
    assert.equal(original.assetHash, renamed.assetHash);
  });

  test('a different token id is a different token, however identical it looks', () => {
    // The attack this blocks: a listing whose name and image are copied from a
    // valuable token, pointing at a worthless one.
    const wanted = asset({ tokenId: '123' });
    const substituted = asset({ tokenId: '124' });
    assert.equal(sameNftAssetV1(wanted, substituted), false);
  });

  test('a different contract is a different token even at the same id', () => {
    const real = asset();
    const impostor = asset({ contractAddress: '0x4444444444444444444444444444444444444444' });
    assert.equal(sameNftAssetV1(real, impostor), false);
  });

  test('blocked media has to say why', () => {
    const parsed = NftAssetRefV1Schema.safeParse({
      ...asset(),
      display: { name: null, collectionName: null, imageUrl: null, imageBlocked: true, imageBlockedReason: null },
    });
    assert.equal(parsed.success, false);
  });
});

describe('a successful receipt is not a purchase', () => {
  const success: NftReceiptLegV1 = {
    status: 'success',
    transactionHash: `0x${'a'.repeat(64)}`,
    blockNumber: '30000000',
    gasUsed: '210000',
    actualNativeValueWei: '19000000000000000',
  };
  const transferred: NftTransferLegV1 = { status: 'observed', fromAddress: SELLER as `0x${string}`, toAddress: BUYER as `0x${string}`, logIndex: 3 };
  const owned: NftOwnershipReadV1 = {
    status: 'verified',
    owner: BUYER as `0x${string}`,
    blockNumber: '30000001',
    observedAt: '2026-07-26T12:00:00.000Z',
    unavailableReason: null,
  };

  test('all three legs together are the only completed purchase', () => {
    assert.equal(
      deriveNftProofFinalStatusV1({ receipt: success, transfer: transferred, ownership: owned, buyer: BUYER }),
      'completed',
    );
  });

  test('a successful receipt with no ownership read is reconciliation_required', () => {
    const status = deriveNftProofFinalStatusV1({
      receipt: success,
      transfer: transferred,
      ownership: { status: 'unverified', owner: null, blockNumber: null, observedAt: null, unavailableReason: 'no rpc' },
      buyer: BUYER,
    });
    assert.equal(status, 'reconciliation_required');
    assert.notEqual(status, 'completed');
  });

  test('a successful receipt with no Transfer log is reconciliation_required', () => {
    assert.equal(
      deriveNftProofFinalStatusV1({
        receipt: success,
        transfer: { status: 'absent', fromAddress: null, toAddress: null, logIndex: null },
        ownership: owned,
        buyer: BUYER,
      }),
      'reconciliation_required',
    );
  });

  test('the token landing somewhere else is a failure, not a success', () => {
    assert.equal(
      deriveNftProofFinalStatusV1({
        receipt: success,
        transfer: { status: 'wrong_recipient', fromAddress: SELLER as `0x${string}`, toAddress: SELLER as `0x${string}`, logIndex: 3 },
        ownership: owned,
        buyer: BUYER,
      }),
      'failed',
    );
  });

  test('ownership held by someone else is a failure, never completed', () => {
    assert.equal(
      deriveNftProofFinalStatusV1({
        receipt: success,
        transfer: transferred,
        ownership: { ...owned, status: 'mismatch', owner: SELLER as `0x${string}` },
        buyer: BUYER,
      }),
      'failed',
    );
  });

  test('a reverted transaction is transaction_failed, and a pending one is pending', () => {
    assert.equal(
      deriveNftProofFinalStatusV1({ receipt: { ...success, status: 'reverted' }, transfer: transferred, ownership: owned, buyer: BUYER }),
      'transaction_failed',
    );
    assert.equal(
      deriveNftProofFinalStatusV1({ receipt: { ...success, status: 'pending' }, transfer: transferred, ownership: owned, buyer: BUYER }),
      'pending',
    );
  });

  test('a proof cannot claim a finalStatus its own legs do not support', () => {
    const legs = {
      receipt: success,
      transfer: transferred,
      ownership: { status: 'unverified' as const, owner: null, blockNumber: null, observedAt: null, unavailableReason: 'no rpc' },
    };
    const parsed = NftPurchaseProofV1Schema.safeParse({
      schemaVersion: 'nft-purchase-proof/v1',
      id: 'nft-proof:1',
      tenantId: 'eip155:8453:0x1111111111111111111111111111111111111111',
      walletAddress: BUYER,
      chainId: 8453,
      createdAt: '2026-07-26T12:00:00.000Z',
      updatedAt: '2026-07-26T12:00:00.000Z',
      status: 'open',
      proofHash: `0x${'0'.repeat(64)}`,
      intentHash: `0x${'1'.repeat(64)}`,
      blueprintHash: `0x${'2'.repeat(64)}`,
      approvedCallsHash: `0x${'3'.repeat(64)}`,
      orderHash: `0x${'4'.repeat(64)}`,
      asset: asset(),
      buyer: BUYER,
      seller: SELLER,
      listingPriceWei: '19000000000000000',
      ...legs,
      // The lie: ownership was never read, yet this claims a purchase.
      finalStatus: 'completed',
      finalizedAt: null,
    });
    assert.equal(parsed.success, false);
    assert.ok(
      JSON.stringify(parsed.error?.issues ?? []).includes('finalStatus'),
      'the rejection must name finalStatus',
    );
  });
});

describe('one listing is not a market', () => {
  test('the recommendation copy makes no cross-market claim', () => {
    assert.equal(NFT_RECOMMENDATION_COPY_V1, 'Best active OpenSea listing for this NFT');
    assert.equal(NFT_RECOMMENDATION_COPY_V1.includes('all marketplaces'), false);
    assert.equal(/across/i.test(NFT_RECOMMENDATION_COPY_V1), false);
  });
});
