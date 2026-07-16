import assert from 'node:assert/strict';
import test from 'node:test';
import { ZERO_HASH_V1, stableHashV1, type AssetRefV1, type ExecutionCallV1 } from '@mioagent/route-domain';
import {
  TransactionReviewProjectionV1Schema,
  hashTransactionReviewProjectionV1,
  type TransactionReviewProjectionV1,
} from '../src/transactionReview.js';

const USDC: AssetRefV1 = {
  assetId: 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  chainId: 8453,
  kind: 'erc20',
  address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  symbol: 'USDC',
  decimals: 6,
};
const ETH: AssetRefV1 = {
  assetId: 'eip155:8453/native',
  chainId: 8453,
  kind: 'native',
  address: null,
  symbol: 'ETH',
  decimals: 18,
};
const WALLET = '0x1111111111111111111111111111111111111111';
const ROUTER = '0x6ff5693b99212da76ad316178a184ab56d299b43';

const CALLS: ExecutionCallV1[] = [
  {
    index: 0,
    callType: 'approval',
    to: USDC.address!,
    valueWei: '0',
    data: '0x095ea7b3',
    asset: USDC,
    amountAtomic: '100000000',
    recipient: null,
    spender: ROUTER,
  },
  {
    index: 1,
    callType: 'swap',
    to: ROUTER,
    valueWei: '0',
    data: '0xabcdef',
    asset: null,
    amountAtomic: null,
    recipient: WALLET,
    spender: null,
  },
];

function fixtureHash(label: string) {
  return stableHashV1('transaction-review-test/v1', { label });
}

function baseDraft(): TransactionReviewProjectionV1 {
  return {
    schemaVersion: 'transaction-review-projection/v1',
    projectionHash: ZERO_HASH_V1,
    readOnly: true,
    routeRunId: 'route-run-1',
    intentHash: fixtureHash('intent'),
    selectedCandidateHash: fixtureHash('candidate'),
    blueprintHash: fixtureHash('blueprint'),
    callsHash: fixtureHash('calls'),
    blueprintStatus: 'ready_for_review',
    provider: { id: 'uniswap', displayName: 'Uniswap', kind: 'dex', operator: 'Uniswap Labs' },
    input: { asset: USDC, amountAtomic: '100000000', amountDecimal: '100' },
    expectedOutput: { asset: ETH, amountAtomic: '38000000000000000', amountDecimal: '0.038' },
    minimumOutput: { asset: ETH, amountAtomic: '37810000000000000', amountDecimal: '0.03781' },
    cardExpectedOutput: { asset: ETH, amountAtomic: '38000000000000000', amountDecimal: '0.038' },
    cardMinimumOutput: { asset: ETH, amountAtomic: '37810000000000000', amountDecimal: '0.03781' },
    quoteExpiry: '2026-07-16T09:05:00.000Z',
    calls: CALLS,
    requiredApprovals: [
      { asset: USDC, spender: ROUTER, amountAtomic: '100000000', approvalKind: 'exact', state: 'required' },
    ],
    attachedNativeValueWei: '0',
    safety: {
      schemaVersion: 'safety-kernel-result/v1',
      verdict: 'allowed',
      checks: [{ id: 'chain_pinned', description: 'Base mainnet', status: 'passed', detail: null }],
      blockedReason: null,
    },
    contractSecurity: {
      provider: 'goplus',
      required: true,
      status: 'passed',
      verdicts: [{ address: USDC.address!, provider: 'goplus', status: 'ok', summary: null }],
    },
    simulationState: {
      status: 'unavailable',
      observedAt: null,
      blockNumber: null,
      requestHash: null,
      responseHash: null,
      errorCode: 'no_simulation_provider',
    },
    simulationWarning: 'No fork-simulation provider is configured; only static preflight checks ran.',
  };
}

function withHash(draft: TransactionReviewProjectionV1): TransactionReviewProjectionV1 {
  return { ...draft, projectionHash: hashTransactionReviewProjectionV1(draft) };
}

test('accepts a well-formed review projection', () => {
  const result = TransactionReviewProjectionV1Schema.safeParse(withHash(baseDraft()));
  assert.equal(result.success, true);
});

test('rejects a projectionHash that does not match the canonical payload', () => {
  const draft = withHash(baseDraft());
  const tampered = { ...draft, projectionHash: ZERO_HASH_V1 };
  assert.equal(TransactionReviewProjectionV1Schema.safeParse(tampered).success, false);
});

test('rejects minimumOutput exceeding expectedOutput', () => {
  const draft = baseDraft();
  draft.minimumOutput = { ...draft.expectedOutput, amountAtomic: '39000000000000000' };
  assert.equal(TransactionReviewProjectionV1Schema.safeParse(withHash(draft)).success, false);
});

test('rejects a blocked Safety Kernel result inside a reviewable projection', () => {
  const draft = baseDraft();
  draft.safety = {
    schemaVersion: 'safety-kernel-result/v1',
    verdict: 'blocked',
    checks: [{ id: 'router_pinned', description: 'Router target pinned', status: 'failed', detail: 'mismatch' }],
    blockedReason: 'Router target is not pinned',
  };
  assert.equal(TransactionReviewProjectionV1Schema.safeParse(withHash(draft)).success, false);
});

test('rejects attachedNativeValueWei that does not match the sum of call values', () => {
  const draft = baseDraft();
  draft.attachedNativeValueWei = '1';
  assert.equal(TransactionReviewProjectionV1Schema.safeParse(withHash(draft)).success, false);
});

test('rejects non-contiguous call indexes', () => {
  const draft = baseDraft();
  draft.calls = [{ ...CALLS[0]! }, { ...CALLS[1]!, index: 2 }];
  assert.equal(TransactionReviewProjectionV1Schema.safeParse(withHash(draft)).success, false);
});
