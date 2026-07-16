import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeFunctionData, erc20Abi } from 'viem';
import { TransactionReviewProjectionV1Schema } from '@mioagent/route-card';
import { assembleExecutionBlueprintV1, blueprintIdV1, classifySwapCallV1 } from '../src/blueprint.js';
import { buildTransactionReviewProjectionV1 } from '../src/reviewProjection.js';
import { NOW, USDC_BASE, ETH_BASE, WALLET } from './fixtures.js';

const ROUTER = '0x6ff5693b99212da76ad316178a184ab56d299b43' as const;

function blueprintFixture() {
  const approveData = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ROUTER, 100_000_000n] });
  const calls = [
    classifySwapCallV1({ index: 0, call: { to: USDC_BASE.address as `0x${string}`, value: '0', data: approveData }, routerAddress: ROUTER, usdcAsset: USDC_BASE, walletAddress: WALLET }),
    classifySwapCallV1({ index: 1, call: { to: ROUTER, value: '0', data: '0x12345678' }, routerAddress: ROUTER, usdcAsset: USDC_BASE, walletAddress: WALLET }),
  ];
  return assembleExecutionBlueprintV1({
    id: blueprintIdV1({ tenantId: 'tenant-1', walletAddress: WALLET, routeRunId: 'run-1', routeCardHash: `0x${'1'.repeat(64)}`, selectedCandidateHash: `0x${'2'.repeat(64)}`, requestId: 'req-1' }),
    tenantId: 'tenant-1',
    walletAddress: WALLET,
    chainId: 8453,
    now: NOW,
    intentHash: `0x${'3'.repeat(64)}`,
    selectedCandidateHash: `0x${'2'.repeat(64)}`,
    evidenceSetHash: `0x${'4'.repeat(64)}`,
    quoteExpiry: new Date(NOW.getTime() + 60_000).toISOString(),
    calls,
    inputAsset: USDC_BASE,
    inputAmountAtomic: '100000000',
    outputAsset: ETH_BASE,
    outputExpectedAtomic: '38000000000000000',
    outputMinimumAtomic: '37810000000000000',
    simulationState: { status: 'unavailable', observedAt: null, blockNumber: null, requestHash: null, responseHash: null, errorCode: 'no_simulation_provider' },
  });
}

test('buildTransactionReviewProjectionV1 produces a valid, hash-consistent read-only projection', () => {
  const blueprint = blueprintFixture();
  const review = buildTransactionReviewProjectionV1({
    routeRunId: 'run-1',
    provider: { id: 'uniswap', displayName: 'Uniswap', kind: 'dex', operator: 'Uniswap Labs' },
    input: { asset: USDC_BASE, amountAtomic: '100000000', amountDecimal: '100' },
    expectedOutput: { asset: ETH_BASE, amountAtomic: '38000000000000000', amountDecimal: '0.038' },
    minimumOutput: { asset: ETH_BASE, amountAtomic: '37810000000000000', amountDecimal: '0.03781' },
    cardExpectedOutput: { asset: ETH_BASE, amountAtomic: '38000000000000000', amountDecimal: '0.038' },
    cardMinimumOutput: { asset: ETH_BASE, amountAtomic: '37810000000000000', amountDecimal: '0.03781' },
    blueprint,
    safety: {
      schemaVersion: 'safety-kernel-result/v1',
      verdict: 'allowed',
      checks: [{ id: 'chain_pinned', description: 'Base mainnet', status: 'passed', detail: null }],
      blockedReason: null,
    },
    contractSecurity: { provider: 'goplus', required: true, status: 'passed', verdicts: [] },
    simulationWarning: 'No fork-simulation provider is configured.',
  });
  assert.equal(TransactionReviewProjectionV1Schema.safeParse(review).success, true);
  assert.equal(review.readOnly, true);
  assert.equal(review.blueprintHash, blueprint.blueprintHash);
});
