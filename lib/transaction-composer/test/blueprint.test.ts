import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeFunctionData, erc20Abi } from 'viem';
import { ExecutionBlueprintV1Schema } from '@mioagent/route-domain';
import { assembleExecutionBlueprintV1, blueprintIdV1, classifySwapCallV1 } from '../src/blueprint.js';
import { NOW, USDC_BASE, WALLET, ETH_BASE } from './fixtures.js';

const ROUTER = '0x6ff5693b99212da76ad316178a184ab56d299b43' as const;
const SPENDER = ROUTER;

test('classifySwapCallV1 decodes an ERC-20 approval and pins the spender/amount', () => {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [SPENDER, 100_000_000n] });
  const call = classifySwapCallV1({
    index: 0,
    call: { to: USDC_BASE.address as `0x${string}`, value: '0', data },
    routerAddress: ROUTER,
    usdcAsset: USDC_BASE,
    walletAddress: WALLET,
  });
  assert.equal(call.callType, 'approval');
  assert.equal(call.amountAtomic, '100000000');
  assert.equal(call.spender, SPENDER);
  assert.equal(call.asset?.symbol, 'USDC');
});

test('classifySwapCallV1 recognizes the pinned router call as a swap bound to the wallet', () => {
  const call = classifySwapCallV1({
    index: 1,
    call: { to: ROUTER, value: '0', data: '0x12345678' },
    routerAddress: ROUTER,
    usdcAsset: USDC_BASE,
    walletAddress: WALLET,
  });
  assert.equal(call.callType, 'swap');
  assert.equal(call.recipient, WALLET);
});

test('classifySwapCallV1 marks an unrecognized target as other rather than throwing', () => {
  const call = classifySwapCallV1({
    index: 0,
    call: { to: '0x9999999999999999999999999999999999999999', value: '0', data: '0xdeadbeef' },
    routerAddress: ROUTER,
    usdcAsset: USDC_BASE,
    walletAddress: WALLET,
  });
  assert.equal(call.callType, 'other');
});

test('blueprintIdV1 is deterministic given the same identifiers', () => {
  const input = {
    tenantId: 'tenant-1',
    walletAddress: WALLET,
    routeRunId: 'run-1',
    routeCardHash: `0x${'1'.repeat(64)}` as const,
    selectedCandidateHash: `0x${'2'.repeat(64)}` as const,
    requestId: 'req-1',
  };
  assert.equal(blueprintIdV1(input), blueprintIdV1({ ...input }));
  assert.notEqual(blueprintIdV1(input), blueprintIdV1({ ...input, requestId: 'req-2' }));
});

test('assembleExecutionBlueprintV1 produces a valid, hash-consistent blueprint with approvedCallsHash null', () => {
  const approveData = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [SPENDER, 100_000_000n] });
  const calls = [
    classifySwapCallV1({
      index: 0,
      call: { to: USDC_BASE.address as `0x${string}`, value: '0', data: approveData },
      routerAddress: ROUTER,
      usdcAsset: USDC_BASE,
      walletAddress: WALLET,
    }),
    classifySwapCallV1({
      index: 1,
      call: { to: ROUTER, value: '0', data: '0x12345678' },
      routerAddress: ROUTER,
      usdcAsset: USDC_BASE,
      walletAddress: WALLET,
    }),
  ];
  const blueprint = assembleExecutionBlueprintV1({
    id: blueprintIdV1({
      tenantId: 'tenant-1',
      walletAddress: WALLET,
      routeRunId: 'run-1',
      routeCardHash: `0x${'1'.repeat(64)}`,
      selectedCandidateHash: `0x${'2'.repeat(64)}`,
      requestId: 'req-1',
    }),
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
    simulationState: {
      status: 'unavailable',
      observedAt: null,
      blockNumber: null,
      requestHash: null,
      responseHash: null,
      errorCode: 'no_simulation_provider',
    },
  });
  assert.equal(ExecutionBlueprintV1Schema.safeParse(blueprint).success, true);
  assert.equal(blueprint.status, 'ready_for_review');
  assert.equal(blueprint.approvedCallsHash, null);
  assert.equal(blueprint.atomicRequired, true);
  assert.equal(blueprint.requiredApprovals.length, 1);
  assert.equal(blueprint.requiredApprovals[0]!.approvalKind, 'exact');
  assert.equal(blueprint.expectedAssetChanges.length, 2);
});
