import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  RouteProofV1Schema,
  ZERO_HASH_V1,
  hashApprovedCallsV1,
  hashRouteProofV1,
  sealPublicProofBundleV1,
  type AssetRefV1,
  type ExecutionCallV1,
  type PublicRouteProofBundleV1,
  type RouteProofV1,
} from '@mioagent/route-domain';

import { decodeTransferCalldataV1, formatAtomicV1, giftOfPublicBundleV1 } from '../src/gift.js';
import { verifyPublicProofBundleV1 } from '../src/verify.js';

// ---------------------------------------------------------------------------
// A gift read out of a public bundle: from the calldata, never the labels.
// ---------------------------------------------------------------------------

const PUBLIC_ID = 'b'.repeat(48);
const GIVER = '0x4de27ead5a3c9aeb58c7f812178ddde282670d70';
const FRIEND = '0x8e525bfce1c0ffee00000000000000000000beef';
const ROUTER = '0x6ff5693b99212da76ad316178a184ab56d299b43';
const NOW = new Date('2026-09-24T10:00:00.000Z');
const GIFT = '44006';

const USDC: AssetRefV1 = {
  assetId: 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  chainId: 8453,
  kind: 'erc20',
  address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  symbol: 'USDC',
  decimals: 6,
};
const NVDA: AssetRefV1 = {
  assetId: 'eip155:8453/erc20:0xb20000000000000000000078ee7ce2fe4908108c',
  chainId: 8453,
  kind: 'erc20',
  address: '0xb20000000000000000000078ee7ce2fe4908108c',
  symbol: 'NVDAc',
  decimals: 8,
};

function word(value: string | bigint): string {
  return (typeof value === 'string' ? value.replace(/^0x/, '') : value.toString(16)).padStart(64, '0');
}

function transferData(recipient: string, amount: string): `0x${string}` {
  return `0xa9059cbb${word(recipient)}${word(BigInt(amount))}`;
}

function giftCall(over: Partial<ExecutionCallV1> = {}): ExecutionCallV1 {
  return {
    index: 1,
    callType: 'transfer',
    to: NVDA.address!,
    valueWei: '0',
    data: transferData(FRIEND, GIFT),
    asset: NVDA,
    amountAtomic: GIFT,
    recipient: FRIEND,
    spender: null,
    ...over,
  };
}

const SWAP: ExecutionCallV1 = {
  index: 0,
  callType: 'swap',
  to: ROUTER,
  valueWei: '0',
  data: '0x3593564c',
  asset: null,
  amountAtomic: null,
  recipient: null,
  spender: null,
};

function bundleWith(calls: ExecutionCallV1[], finalStatus: RouteProofV1['finalStatus'] = 'completed'): PublicRouteProofBundleV1 {
  const nowIso = NOW.toISOString();
  const txHash = `0x${'1'.repeat(64)}` as const;
  const receipts: RouteProofV1['receipts'] = [
    { transactionHash: txHash, status: finalStatus === 'completed' ? 'success' : 'reverted', blockNumber: '49000000', gasUsed: '150000' },
  ];
  const draft: RouteProofV1 = {
    schemaVersion: 'route-proof/v1',
    id: 'route-proof:gift',
    tenantId: `eip155:8453:${GIVER}`,
    walletAddress: GIVER,
    chainId: 8453,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: finalStatus,
    intentHash: `0x${'a'.repeat(64)}`,
    selectedCandidateHash: `0x${'b'.repeat(64)}`,
    evidenceSetHash: `0x${'c'.repeat(64)}`,
    blueprintHash: `0x${'d'.repeat(64)}`,
    approvedCallsHash: hashApprovedCallsV1(calls),
    proofHash: ZERO_HASH_V1,
    approvedCalls: calls,
    expectedResult: {
      assetChanges: [
        { asset: USDC, direction: 'debit', amountAtomic: '100000', minimumAmountAtomic: null, maximumAmountAtomic: '100000' },
        { asset: NVDA, direction: 'credit', amountAtomic: '44227', minimumAmountAtomic: GIFT, maximumAmountAtomic: null },
      ],
      outputAmountAtomic: '44227',
      outputAsset: NVDA,
    },
    actualResult: {
      assetChanges: [
        { asset: USDC, direction: 'debit', amountAtomic: '100000', minimumAmountAtomic: null, maximumAmountAtomic: null },
        { asset: NVDA, direction: 'credit', amountAtomic: '44227', minimumAmountAtomic: null, maximumAmountAtomic: null },
      ],
      outputAmountAtomic: '44227',
      outputAsset: NVDA,
    },
    estimatedGas: { gasUnits: '200000', maxFeePerGasWei: '1000000', estimatedCostNative: '200000000000', estimatedCostUsd: '0.01' },
    actualGas: { gasUnits: '150000', maxFeePerGasWei: '1000000', estimatedCostNative: '150000000000', estimatedCostUsd: '0.0075' },
    deviation: { outputBps: 0, gasCostUsd: '0', withinTolerance: true },
    transactionHashes: [txHash],
    receipts,
    finalStatus,
    reconciliationState: finalStatus === 'completed' ? 'matched' : 'failed',
  };
  const proof = RouteProofV1Schema.parse({ ...draft, proofHash: hashRouteProofV1(draft) });
  return sealPublicProofBundleV1<PublicRouteProofBundleV1>({
    schemaVersion: 'public-proof-bundle/v1',
    publicProofId: PUBLIC_ID,
    proofFamily: 'route',
    issuedAt: NOW.toISOString(),
    provider: null,
    proof,
    events: [],
  });
}

describe('a gift in a public bundle', () => {
  test('is read from the transfer calldata, with who paid and who received', () => {
    const bundle = bundleWith([SWAP, giftCall()]);
    assert.equal(verifyPublicProofBundleV1(bundle).valid, true);
    assert.deepEqual(giftOfPublicBundleV1(bundle), {
      giver: GIVER,
      recipient: FRIEND,
      amountAtomic: GIFT,
      token: { address: NVDA.address, symbol: 'NVDAc', decimals: 8 },
      finalStatus: 'completed',
      delivered: true,
      transactionHash: `0x${'1'.repeat(64)}`,
      source: 'bought',
      paid: { amountAtomic: '100000', symbol: 'USDC', decimals: 6 },
      issuedAt: NOW.toISOString(),
    });
  });

  test('a transfer alone is a gift from what the giver held, and nothing was paid', () => {
    const bundle = bundleWith([giftCall({ index: 0 })]);
    assert.equal(verifyPublicProofBundleV1(bundle).valid, true);
    const gift = giftOfPublicBundleV1(bundle);
    assert.equal(gift?.source, 'held');
    assert.equal(gift?.paid, null);
    assert.equal(gift?.recipient, FRIEND);
    assert.equal(gift?.amountAtomic, GIFT);
    assert.equal(gift?.delivered, true);
    // Its labels are held to its bytes exactly as a bought gift's are.
    assert.equal(giftOfPublicBundleV1(bundleWith([giftCall({ index: 0, amountAtomic: '1' })])), null);
    // A single call that is not a transfer is no gift at all.
    assert.equal(giftOfPublicBundleV1(bundleWith([SWAP])), null);
  });

  test('a failed proof is a gift that was not delivered', () => {
    const gift = giftOfPublicBundleV1(bundleWith([SWAP, giftCall()], 'failed'));
    assert.equal(gift?.delivered, false);
    assert.equal(gift?.finalStatus, 'failed');
  });

  test('an ordinary swap is not a gift', () => {
    assert.equal(giftOfPublicBundleV1(bundleWith([SWAP, { ...SWAP, index: 1 }])), null);
  });

  test('labels that disagree with the bytes describe no gift', () => {
    const forgedRecipient = giftCall({ data: transferData('0x000000000000000000000000000000000000dead', GIFT) });
    assert.equal(giftOfPublicBundleV1(bundleWith([SWAP, forgedRecipient])), null);
    const forgedAmount = giftCall({ amountAtomic: '44007' });
    assert.equal(giftOfPublicBundleV1(bundleWith([SWAP, forgedAmount])), null);
    const otherToken = giftCall({ to: USDC.address! });
    assert.equal(giftOfPublicBundleV1(bundleWith([SWAP, otherToken])), null);
  });

  test('the transfer must be the last call, and the only one', () => {
    assert.equal(giftOfPublicBundleV1(bundleWith([giftCall({ index: 0 }), { ...SWAP, index: 1 }])), null);
    assert.equal(
      giftOfPublicBundleV1(bundleWith([SWAP, giftCall(), giftCall({ index: 2 })])),
      null,
    );
  });

  test('anything that is not a route bundle is not a gift', () => {
    for (const value of [null, undefined, 'x', {}, { proofFamily: 'nft', proof: {} }]) {
      assert.equal(giftOfPublicBundleV1(value), null);
    }
  });
});

describe('transfer calldata', () => {
  test('decodes exactly one shape', () => {
    assert.deepEqual(decodeTransferCalldataV1(transferData(FRIEND, GIFT)), { recipient: FRIEND, amountAtomic: GIFT });
    // Trailing bytes, a short word, a dirty address word, another selector.
    assert.equal(decodeTransferCalldataV1(`${transferData(FRIEND, GIFT)}00`), null);
    assert.equal(decodeTransferCalldataV1(transferData(FRIEND, GIFT).slice(0, -2)), null);
    assert.equal(decodeTransferCalldataV1(`0xa9059cbb${'f'.repeat(24)}${FRIEND.slice(2)}${word(1n)}`), null);
    assert.equal(decodeTransferCalldataV1(`0x23b872dd${word(FRIEND)}${word(1n)}`), null);
  });

  test('amounts read as decimals', () => {
    assert.equal(formatAtomicV1('44006', 8), '0.00044006');
    assert.equal(formatAtomicV1('100000', 6), '0.1');
    assert.equal(formatAtomicV1('100000000', 6), '100');
    assert.equal(formatAtomicV1('0', 6), '0');
  });
});
