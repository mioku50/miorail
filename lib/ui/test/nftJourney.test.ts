import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  NFT_PROOF_HEADLINE_V1,
  NFT_RECOMMENDATION_COPY_V1,
  NftProofPanel,
  NftReviewPanel,
  NftRouteCardPanel,
  dispatchRouteFamilyV1,
  routeFamilyForGoalV1,
  type NftAssetLikeV1,
  type NftProofLikeV1,
  type NftRouteCardLikeV1,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// T65.1 Final §5/§6 — the whole NFT journey, rendered.
//
// Comparing → NFT Route Card → Review → Confirm in Base Account → Proof, with
// every value mocked and nothing fetched. Both surfaces render THESE panels, so
// what holds here holds for web and miniapp alike; each surface's own test then
// asserts it mounts them in this order.
//
// The thing being protected is the copy at each step. A screen may say what the
// chain confirmed and nothing else — no "purchase completed" before an
// ownership read, and no wallet button before every gate passed.
// ---------------------------------------------------------------------------

const BUYER = '0x1111111111111111111111111111111111111111';
const SELLER = '0x4efca7cc8058d5acd2bb2ccd2a9430906291cdd6';
const COLLECTION = '0x41dc69132cce31fcbf6755c84538ca268520246f';
const SEAPORT = '0x0000000000000068f116a894984e2db1123eb395';
const TX = `0x${'f'.repeat(64)}`;
const PRICE = '3580000000000000';

const asset: NftAssetLikeV1 = {
  chain: 'base',
  contractAddress: COLLECTION,
  tokenId: '16668',
  tokenStandard: 'erc721',
  collectionSlug: 'basepaint',
  display: {
    name: 'IzioGh0st',
    collectionName: 'BasePaint',
    imageUrl: null,
    imageBlocked: true,
    imageBlockedReason: 'Images from this marketplace are not shown on this deployment.',
  },
};

const card: NftRouteCardLikeV1 = {
  routeCardHash: `0x${'c'.repeat(64)}`,
  status: 'ready',
  asset,
  candidate: {
    listingPriceWei: PRICE,
    estimatedGasWei: '210000000000000',
    listingStatus: 'active',
    listingExpiresAt: '2026-07-27T11:43:50.000Z',
    creatorFeePolicy: 'enforced',
    order: { orderHash: `0x${'d'.repeat(64)}`, protocolAddress: SEAPORT, seller: SELLER },
  },
  dimensions: [{ dimension: 'price', score: 90, notScoredReason: null }],
  evidenceGaps: [],
  maxSpendWei: '20000000000000000',
  totalCostWei: '3790000000000000',
  failureReason: null,
  expiresAt: '2026-07-26T12:00:30.000Z',
};

function proofAt(overrides: Partial<NftProofLikeV1> = {}): NftProofLikeV1 {
  return {
    proofHash: `0x${'e'.repeat(64)}`,
    finalStatus: 'pending',
    buyer: BUYER,
    seller: SELLER,
    listingPriceWei: PRICE,
    receipt: { status: 'pending', transactionHash: TX, blockNumber: null, gasUsed: null, actualNativeValueWei: null },
    transfer: { status: 'absent', fromAddress: null, toAddress: null },
    ownership: { status: 'unverified', owner: null, blockNumber: null, unavailableReason: 'The transaction has not been confirmed yet.' },
    ...overrides,
  };
}

const completed = proofAt({
  finalStatus: 'completed',
  receipt: { status: 'success', transactionHash: TX, blockNumber: '30000000', gasUsed: '210000', actualNativeValueWei: PRICE },
  transfer: { status: 'observed', fromAddress: SELLER, toAddress: BUYER },
  ownership: { status: 'verified', owner: BUYER, blockNumber: '30000001', unavailableReason: null },
});

describe('the NFT journey renders end to end', () => {
  test('the Route Card names the token by identity, and leads with honest copy', () => {
    const html = renderToStaticMarkup(createElement(NftRouteCardPanel, { card }));
    // Every panel is built from the console's own vocabulary; consoleStyles
    // then proves each of those classes has a rule.
    assert.ok(html.startsWith('<div class="panel"'), 'the card is a console panel');
    assert.ok(html.includes('class="qrow"'), 'facts render as key/value rows, not run-together text');
    assert.ok(html.includes(NFT_RECOMMENDATION_COPY_V1));
    // Identity is chain + contract + tokenId. The name may appear beside it,
    // never instead of it.
    assert.ok(html.includes(COLLECTION));
    assert.ok(html.includes('16668'));
    assert.ok(html.includes('Base mainnet · 8453'), 'the chain is named, not shown as a CAIP id');
    // The blocked image renders a placeholder and states why.
    assert.ok(html.includes('No image'));
    assert.ok(!html.includes('<img'));
    for (const forbidden of ['Best NFT price', 'Safest NFT', 'Purchase completed']) {
      assert.ok(!html.includes(forbidden), `the card must never say "${forbidden}"`);
    }
  });

  test('Review shows every value the spec requires before a wallet opens', () => {
    const html = renderToStaticMarkup(
      createElement(NftReviewPanel, {
        card,
        blueprintHash: `0x${'a'.repeat(64)}`,
        callsHash: `0x${'b'.repeat(64)}`,
        valueWei: PRICE,
        restrictedByZone: false,
        simulation: { status: 'passed', blockNumber: '30000000', gasUsed: '214000', errorCode: null },
        safety: { ok: true, violations: [] },
        signable: true,
        blockedReason: null,
        submitSlot: createElement('button', { type: 'button' }, 'Confirm in Base Account'),
      }),
    );
    assert.ok(html.includes('basic fulfilment'), 'the order form is stated');
    assert.ok(html.includes('0.00358 ETH'), 'the exact value is stated');
    assert.ok(html.includes('Seaport 1.6'), 'the Seaport target is stated');
    assert.ok(html.includes('2026-07-27T11:43:50.000Z'), 'the listing expiry is stated');
    assert.ok(html.includes('30000000') && html.includes('214000'), 'simulation block and gas are stated');
    assert.ok(html.includes('1 × ERC721 #16668'), 'the expected NFT credit is stated');
    assert.ok(html.includes('0xaaaaaa…aaaaaa'), 'the blueprint hash is stated');
    assert.ok(html.includes('0xbbbbbb…bbbbbb'), 'the calls hash is stated');
    assert.ok(html.includes('Confirm in Base Account'), 'the shared submit control is rendered');
  });

  test('an unsignable review renders the reason INSTEAD of a wallet button', () => {
    const html = renderToStaticMarkup(
      createElement(NftReviewPanel, {
        card,
        blueprintHash: `0x${'a'.repeat(64)}`,
        callsHash: `0x${'b'.repeat(64)}`,
        valueWei: PRICE,
        simulation: { status: 'unavailable', blockNumber: null, errorCode: 'provider_not_configured' },
        safety: { ok: true, violations: [] },
        signable: false,
        blockedReason: 'Simulation is unavailable, so nothing can be signed.',
        submitSlot: createElement('button', { type: 'button' }, 'Confirm in Base Account'),
      }),
    );
    assert.ok(html.includes('Simulation is unavailable'));
    assert.ok(!html.includes('Confirm in Base Account'), 'no wallet control when a gate failed');
  });

  test('a submitted purchase is pending, not completed', () => {
    const html = renderToStaticMarkup(createElement(NftProofPanel, { proof: proofAt(), asset }));
    assert.ok(html.includes(NFT_PROOF_HEADLINE_V1.pending));
    assert.ok(!html.includes('Purchase completed'), 'nothing is completed before the chain says so');
    assert.ok(html.includes('Not independently confirmed'));
  });

  test('a succeeded receipt without ownership says exactly that', () => {
    const html = renderToStaticMarkup(
      createElement(NftProofPanel, {
        proof: proofAt({
          finalStatus: 'reconciliation_required',
          receipt: { status: 'success', transactionHash: TX, blockNumber: '30000000', gasUsed: '210000', actualNativeValueWei: PRICE },
          ownership: { status: 'unverified', owner: null, blockNumber: null, unavailableReason: 'The ownership read did not answer.' },
        }),
        asset,
      }),
    );
    assert.equal(html.includes('Receipt confirmed, ownership still being verified'), true);
    assert.ok(!html.includes('Purchase completed'));
  });

  test('a token that reached someone else is not a purchase', () => {
    const html = renderToStaticMarkup(
      createElement(NftProofPanel, {
        proof: proofAt({
          finalStatus: 'failed',
          receipt: { status: 'success', transactionHash: TX, blockNumber: '30000000', gasUsed: '210000', actualNativeValueWei: PRICE },
          transfer: { status: 'wrong_recipient', fromAddress: SELLER, toAddress: '0x2222222222222222222222222222222222222222' },
          ownership: { status: 'mismatch', owner: '0x2222222222222222222222222222222222222222', blockNumber: '30000001', unavailableReason: null },
        }),
        asset,
      }),
    );
    assert.ok(html.includes('Ownership could not be independently proven'));
    assert.ok(html.includes('not you'));
  });

  test('only a verified ownership read may say the purchase completed', () => {
    const html = renderToStaticMarkup(createElement(NftProofPanel, { proof: completed, asset }));
    assert.ok(html.includes('Purchase completed and ownership verified'));
    // Every field §4 asks for, on one screen.
    assert.ok(html.includes(COLLECTION), 'the NFT contract');
    assert.ok(html.includes('16668'), 'the token ID');
    assert.ok(html.includes('0x4efca7…91cdd6'), 'the previous owner');
    assert.ok(html.includes('0x111111…111111'), 'the authenticated new owner');
    assert.ok(html.includes('30000001'), 'the ownership block');
    assert.ok(html.includes('210000'), 'gas');
    assert.ok(html.includes('0xeeeeee…eeeeee'), 'the proof hash');
    assert.ok(html.includes(`${TX.slice(0, 8)}…${TX.slice(-6)}`), 'the transaction hash');
  });

  test('the journey belongs to the NFT family from the goal onwards', () => {
    const goal = 'Buy NFT BasePaint #16668 under 0.02 ETH on Base';
    assert.equal(routeFamilyForGoalV1(goal), 'nft');
    const dispatched = dispatchRouteFamilyV1(goal, {
      routeIntelligenceV1: true,
      earnRouteV1: true,
      commerceRouteV1: true,
      commerceExecutionV1: true,
      nftRouteV1: true,
      nftExecutionV1: true,
    });
    assert.equal(dispatched.engine, 'nft');
  });
});
