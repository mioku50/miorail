import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData } from 'viem';
import {
  hashNftAssetRefV1,
  hashNftListingCandidateV1,
  hashNftPurchaseIntentV1,
  type ExecutionCallV1,
  type NftAssetRefV1,
  type NftListingCandidateV1,
  type NftPurchaseIntentV1,
} from '@mioagent/route-domain';
import {
  NFT_SEAPORT_TARGETS_V1,
  nftPurchaseSafetyKernelV1,
  nftPurchaseSignableV1,
  verifyNftIdentityV1,
  verifyNftListingUnchangedV1,
  verifyNftListingV1,
  verifyNftRecipientV1,
  SEAPORT_FULFILL_BASIC_ORDER_ABI_V1,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// T65 §3 / §7 — the checks that stand between a listing and someone's money.
//
// Pure and offline. There is no fetch in this file and no network in this
// package's tests: a safety check that needs a network to be correct is not a
// safety check.
// ---------------------------------------------------------------------------

const BUYER = '0x1111111111111111111111111111111111111111' as const;
const SELLER = '0x2222222222222222222222222222222222222222' as const;
const CONTRACT = '0x3333333333333333333333333333333333333333' as const;
const SEAPORT = NFT_SEAPORT_TARGETS_V1[0];
const NOW = new Date('2026-07-26T12:00:00.000Z');
const EXPIRES = '2026-07-26T12:30:00.000Z';
const FULFILLMENT_HASH = `0x${'f'.repeat(64)}` as const;

function asset(overrides: Partial<NftAssetRefV1> = {}): NftAssetRefV1 {
  const base = {
    schemaVersion: 'nft-asset-ref/v1',
    assetHash: `0x${'0'.repeat(64)}`,
    chain: 'eip155:8453',
    contractAddress: CONTRACT,
    tokenId: '123',
    tokenStandard: 'erc721',
    collectionSlug: 'basepaint',
    display: { name: 'BasePaint #123', collectionName: 'BasePaint', imageUrl: null, imageBlocked: false, imageBlockedReason: null },
    ...overrides,
  } as NftAssetRefV1;
  return { ...base, assetHash: hashNftAssetRefV1(base) };
}

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
    intentHash: `0x${'0'.repeat(64)}`,
    goal: 'nft_purchase',
    inputSource: 'slug_and_token',
    collectionSlug: 'basepaint',
    contractAddress: CONTRACT,
    tokenId: '123',
    maxSpendWei: '20000000000000000',
    paymentAsset: 'native_eth',
    quantity: 1,
    tokenStandard: 'erc721',
    verificationDepth: 'standard',
    executionRequested: false,
    ...overrides,
  } as NftPurchaseIntentV1;
  return { ...base, intentHash: hashNftPurchaseIntentV1(base) };
}

function candidate(overrides: Partial<NftListingCandidateV1> = {}): NftListingCandidateV1 {
  const base = {
    schemaVersion: 'nft-listing-candidate/v1',
    id: 'nft-candidate:1',
    tenantId: `eip155:8453:${BUYER}`,
    walletAddress: BUYER,
    chainId: 8453,
    createdAt: '2026-07-26T11:59:30.000Z',
    updatedAt: '2026-07-26T11:59:30.000Z',
    status: 'quoted',
    candidateHash: `0x${'0'.repeat(64)}`,
    intentHash: `0x${'1'.repeat(64)}`,
    provider: { id: 'opensea', displayName: 'OpenSea', kind: 'marketplace' },
    asset: asset(),
    order: { orderHash: `0x${'a'.repeat(64)}`, protocolAddress: SEAPORT, seller: SELLER, restrictedTaker: null },
    listingStatus: 'active',
    listingPriceWei: '19000000000000000',
    creatorFeeBps: 500,
    creatorFeePolicy: 'included_in_price',
    paymentAsset: 'native_eth',
    estimatedGasWei: '300000000000000',
    observedAt: '2026-07-26T11:59:30.000Z',
    listingExpiresAt: EXPIRES,
    ...overrides,
  } as NftListingCandidateV1;
  return { ...base, candidateHash: hashNftListingCandidateV1(base) };
}

/** Real BasicOrder calldata for the fixture listing. The kernel DECODES the
 * bytes now, so a placeholder would be refused — correctly. */
function basicCalldata(overrides: Record<string, unknown> = {}): `0x${string}` {
  return encodeFunctionData({
    abi: SEAPORT_FULFILL_BASIC_ORDER_ABI_V1,
    functionName: 'fulfillBasicOrder_efficient_6GL6yc',
    args: [
      {
        considerationToken: '0x0000000000000000000000000000000000000000',
        considerationIdentifier: 0n,
        considerationAmount: 18_810_000_000_000_000n,
        offerer: SELLER,
        zone: '0x0000000000000000000000000000000000000000',
        offerToken: CONTRACT,
        offerIdentifier: 123n,
        offerAmount: 1n,
        basicOrderType: 0,
        startTime: 1n,
        endTime: 99_999_999_999n,
        zoneHash: `0x${'0'.repeat(64)}`,
        salt: 0n,
        offererConduitKey: `0x${'0'.repeat(64)}`,
        fulfillerConduitKey: `0x${'0'.repeat(64)}`,
        totalOriginalAdditionalRecipients: 1n,
        additionalRecipients: [{ amount: 190_000_000_000_000n, recipient: SELLER }],
        signature: '0xdead',
        ...overrides,
      } as never,
    ],
  });
}

function call(overrides: Partial<ExecutionCallV1> = {}): ExecutionCallV1 {
  return {
    index: 0,
    callType: 'other',
    to: SEAPORT,
    valueWei: '19000000000000000',
    data: basicCalldata(),
    asset: null,
    amountAtomic: null,
    recipient: null,
    spender: null,
    ...overrides,
  } as ExecutionCallV1;
}

function kernel(overrides: Partial<Parameters<typeof nftPurchaseSafetyKernelV1>[0]> = {}) {
  const listing = overrides.candidate ?? candidate();
  return nftPurchaseSafetyKernelV1({
    intent: intent(),
    candidate: listing,
    calls: [call()],
    buyer: BUYER,
    fulfillmentResponseHash: FULFILLMENT_HASH,
    blueprintFulfillmentResponseHash: FULFILLMENT_HASH,
    reviewedCreatorFeePolicy: listing.creatorFeePolicy,
    now: NOW,
    ...overrides,
  });
}

describe('identity is never metadata', () => {
  test('a listing with a matching name on a different token is refused', () => {
    // The most profitable lie an NFT response can tell: the right picture and
    // the right name, on the wrong token.
    const impostor = asset({
      tokenId: '999',
      display: { name: 'BasePaint #123', collectionName: 'BasePaint', imageUrl: null, imageBlocked: false, imageBlockedReason: null },
    });
    const result = verifyNftIdentityV1({ intent: intent(), asset: impostor });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'asset_mismatch');
  });

  test('the same token id on a different contract is refused', () => {
    const impostor = asset({ contractAddress: '0x4444444444444444444444444444444444444444' });
    assert.equal(verifyNftIdentityV1({ intent: intent(), asset: impostor }).ok, false);
  });

  test('an ERC-1155 is refused by name rather than misread', () => {
    const result = verifyNftIdentityV1({ intent: intent(), asset: asset({ tokenStandard: 'erc1155' }) });
    assert.equal(result.ok === false && result.reason, 'standard_unsupported');
  });

  test('a slug-only intent binds to whatever contract resolved', () => {
    // Nothing to compare against, so this must pass — and every later check is
    // bound to the contract that came back.
    assert.equal(verifyNftIdentityV1({ intent: intent({ contractAddress: null }), asset: asset() }).ok, true);
  });
});

describe('a listing has to be buyable', () => {
  test('an active, public, unexpired, in-budget listing verifies', () => {
    assert.equal(verifyNftListingV1({ intent: intent(), candidate: candidate(), now: NOW }).ok, true);
  });

  test('a cancelled or filled listing is refused', () => {
    for (const listingStatus of ['cancelled', 'filled', 'expired', 'unknown'] as const) {
      const result = verifyNftListingV1({ intent: intent(), candidate: candidate({ listingStatus }), now: NOW });
      assert.equal(result.ok === false && result.reason, 'listing_not_active', listingStatus);
    }
  });

  test('a private listing is refused', () => {
    const listing = candidate({
      order: { orderHash: `0x${'a'.repeat(64)}`, protocolAddress: SEAPORT, seller: SELLER, restrictedTaker: SELLER },
    });
    const result = verifyNftListingV1({ intent: intent(), candidate: listing, now: NOW });
    assert.equal(result.ok === false && result.reason, 'listing_private');
  });

  test('a listing that already expired is refused', () => {
    const result = verifyNftListingV1({
      intent: intent(),
      candidate: candidate(),
      now: new Date('2026-07-26T13:00:00.000Z'),
    });
    assert.equal(result.ok === false && result.reason, 'listing_expired');
  });

  test('a price above the ceiling is refused', () => {
    const result = verifyNftListingV1({
      intent: intent(),
      candidate: candidate({ listingPriceWei: '21000000000000000' }),
      now: NOW,
    });
    assert.equal(result.ok === false && result.reason, 'price_above_ceiling');
  });

  test('a protocol address that is not a pinned Seaport is refused', () => {
    const listing = candidate({
      order: { orderHash: `0x${'a'.repeat(64)}`, protocolAddress: '0x5555555555555555555555555555555555555555', seller: SELLER, restrictedTaker: null },
    });
    const result = verifyNftListingV1({ intent: intent(), candidate: listing, now: NOW });
    assert.equal(result.ok === false && result.reason, 'protocol_not_allowlisted');
  });
});

describe('the listing at signing time is the listing that was reviewed', () => {
  const fresh = {
    orderHash: `0x${'a'.repeat(64)}`,
    protocolAddress: SEAPORT as string,
    listingStatus: 'active' as const,
    listingPriceWei: '19000000000000000',
    asset: asset(),
    restrictedTaker: null as string | null,
    listingExpiresAt: EXPIRES,
  };

  test('an unchanged listing passes', () => {
    assert.equal(verifyNftListingUnchangedV1({ candidate: candidate(), fresh, now: NOW }).ok, true);
  });

  test('a listing cancelled since the review stops the purchase', () => {
    const result = verifyNftListingUnchangedV1({ candidate: candidate(), fresh: { ...fresh, listingStatus: 'cancelled' }, now: NOW });
    assert.equal(result.ok === false && result.reason, 'listing_not_active');
  });

  test('a price that moved — even downward — is not the reviewed listing', () => {
    // Cheaper is still different terms than the ones shown.
    const result = verifyNftListingUnchangedV1({ candidate: candidate(), fresh: { ...fresh, listingPriceWei: '1' }, now: NOW });
    assert.equal(result.ok, false);
  });

  test('a different order hash is never silently substituted', () => {
    const result = verifyNftListingUnchangedV1({ candidate: candidate(), fresh: { ...fresh, orderHash: `0x${'b'.repeat(64)}` }, now: NOW });
    assert.equal(result.ok === false && result.reason, 'order_incomplete');
  });
});

describe('the safety kernel reads the call, not the summary', () => {
  test('a correct purchase passes', () => {
    assert.deepEqual(kernel(), { ok: true, violations: [] });
  });

  test('a call sending more than the ceiling is blocked however the object is labelled', () => {
    // The fields all say 0.019 ETH. The call sends 2 ETH. Only the call runs.
    const result = kernel({ calls: [call({ valueWei: '2000000000000000000' })] });
    assert.equal(result.ok, false);
    assert.ok(result.violations.includes('value_exceeds_ceiling'));
    assert.ok(result.violations.includes('value_exceeds_listing_price'));
  });

  test('a call to a contract that is not the order’s Seaport is blocked', () => {
    const result = kernel({ calls: [call({ to: '0x5555555555555555555555555555555555555555' })] });
    assert.equal(result.ok, false);
    assert.ok(result.violations.includes('target_not_seaport'));
    assert.ok(result.violations.includes('target_not_order_protocol'));
  });

  test('an ERC-20 approval smuggled into a native purchase is blocked', () => {
    const result = kernel({ calls: [call({ data: '0x095ea7b3000000000000000000000000' })] });
    assert.equal(result.ok, false);
    assert.ok(result.violations.includes('erc20_approval_present'));
  });

  test('a second call is blocked — one purchase is one call', () => {
    const result = kernel({ calls: [call(), call({ index: 1 })] });
    assert.equal(result.ok, false);
    assert.ok(result.violations.includes('wrong_call_count'));
  });

  test('calldata that did not come from the recorded fulfillment is blocked', () => {
    const result = kernel({ blueprintFulfillmentResponseHash: `0x${'e'.repeat(64)}` });
    assert.equal(result.ok, false);
    assert.ok(result.violations.includes('calldata_not_from_fulfillment'));
  });

  test('a creator-fee policy that changed after the review is blocked', () => {
    const result = kernel({ reviewedCreatorFeePolicy: 'added_at_fulfillment' });
    assert.equal(result.ok, false);
    assert.ok(result.violations.includes('creator_fee_policy_changed'));
  });

  test('a buyer who is not the authenticated wallet is blocked', () => {
    const result = kernel({ buyer: SELLER });
    assert.equal(result.ok, false);
    assert.ok(result.violations.includes('buyer_mismatch'));
  });

  test('a listing that expired between review and signing is blocked', () => {
    const result = kernel({ now: new Date('2026-07-26T13:00:00.000Z') });
    assert.equal(result.ok, false);
    assert.ok(result.violations.includes('listing_expired'));
  });

  test('every violation is reported, not just the first', () => {
    const result = kernel({ calls: [call({ to: '0x5555555555555555555555555555555555555555', valueWei: '9000000000000000000' })] });
    assert.ok(result.violations.length >= 3, `expected several violations, got ${result.violations.join(', ')}`);
  });
});

describe('nothing is signed on a guess', () => {
  test('no payload without a passing simulation', () => {
    for (const simulationStatus of ['failed', 'unavailable'] as const) {
      const result = nftPurchaseSignableV1({ safety: { ok: true, violations: [] }, simulationStatus, executionEnabled: true });
      assert.equal(result.signable, false, simulationStatus);
      assert.ok(result.reason);
    }
  });

  test('no payload while the execution gate is off', () => {
    const result = nftPurchaseSignableV1({ safety: { ok: true, violations: [] }, simulationStatus: 'passed', executionEnabled: false });
    assert.equal(result.signable, false);
  });

  test('a failed safety check names the violations in the refusal', () => {
    const result = nftPurchaseSignableV1({
      safety: { ok: false, violations: ['value_exceeds_ceiling'] },
      simulationStatus: 'passed',
      executionEnabled: true,
    });
    assert.equal(result.signable, false);
    assert.match(String(result.reason), /value_exceeds_ceiling/);
  });

  test('a clean purchase with a passing simulation is signable', () => {
    const result = nftPurchaseSignableV1({ safety: { ok: true, violations: [] }, simulationStatus: 'passed', executionEnabled: true });
    assert.deepEqual(result, { signable: true, reason: null });
  });
});

describe('the wallet is the only recipient', () => {
  test('a fulfiller or recipient that is not the authenticated wallet is refused', () => {
    assert.equal(verifyNftRecipientV1({ authenticatedWallet: BUYER, fulfiller: SELLER, recipient: null }).ok, false);
    assert.equal(verifyNftRecipientV1({ authenticatedWallet: BUYER, fulfiller: null, recipient: SELLER }).ok, false);
    assert.equal(verifyNftRecipientV1({ authenticatedWallet: BUYER, fulfiller: BUYER, recipient: BUYER }).ok, true);
  });
});
