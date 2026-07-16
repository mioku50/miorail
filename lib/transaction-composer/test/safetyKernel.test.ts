import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeFunctionData, erc20Abi } from 'viem';
import type { ExecutionCallV1 } from '@mioagent/route-domain';
import { runSafetyKernel } from '../src/safetyKernel.js';
import { NOW, USDC_BASE, WALLET, makeIntent } from './fixtures.js';

const ROUTER = '0x6ff5693b99212da76ad316178a184ab56d299b43' as const;

function approvalCall(amountAtomic: bigint, spender: `0x${string}` = ROUTER): ExecutionCallV1 {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amountAtomic] });
  return {
    index: 0,
    callType: 'approval',
    to: USDC_BASE.address as `0x${string}`,
    valueWei: '0',
    data,
    asset: USDC_BASE,
    amountAtomic: amountAtomic.toString(),
    recipient: null,
    spender,
  };
}

function swapCall(index = 1): ExecutionCallV1 {
  return {
    index,
    callType: 'swap',
    to: ROUTER,
    valueWei: '0',
    data: '0x12345678',
    asset: null,
    amountAtomic: null,
    recipient: WALLET,
    spender: null,
  };
}

function baseArgs(overrides: Partial<Parameters<typeof runSafetyKernel>[0]> = {}) {
  const intent = makeIntent();
  return {
    provider: 'uniswap' as const,
    routerAddress: ROUTER,
    chainId: 8453,
    walletAddress: WALLET,
    intent,
    calls: [approvalCall(BigInt(intent.amount.amountAtomic)), swapCall()],
    quoteExpiry: new Date(NOW.getTime() + 60_000).toISOString(),
    now: NOW,
    contractSecurityRequired: true,
    contractSecurityProvider: 'goplus',
    contractSecurityResults: [{ address: USDC_BASE.address!, provider: 'goplus' as const, status: 'ok' as const, summary: 'clean' }],
    contractSecurityAddresses: [USDC_BASE.address as `0x${string}`],
    simulationAcceptable: true,
    simulationDetail: 'ok',
    intentHash: intent.intentHash,
    selectedCandidateHash: `0x${'1'.repeat(64)}` as const,
    ...overrides,
  };
}

test('allows a well-formed Uniswap batch with passing contract security', () => {
  const { result } = runSafetyKernel(baseArgs());
  assert.equal(result.verdict, 'allowed');
  assert.equal(result.blockedReason, null);
});

test('blocks an unlimited approval amount', () => {
  const intent = makeIntent();
  const { result } = runSafetyKernel(
    baseArgs({ calls: [approvalCall((1n << 256n) - 1n), swapCall()], intent }),
  );
  assert.equal(result.verdict, 'blocked');
  assert.ok(result.blockedReason);
});

test('blocks an unrecognized call target (call classified as other)', () => {
  const otherCall: ExecutionCallV1 = {
    index: 1,
    callType: 'other',
    to: '0x9999999999999999999999999999999999999999',
    valueWei: '0',
    data: '0xdeadbeef',
    asset: null,
    amountAtomic: null,
    recipient: null,
    spender: null,
  };
  const intent = makeIntent();
  const { result } = runSafetyKernel(
    baseArgs({ calls: [approvalCall(BigInt(intent.amount.amountAtomic)), otherCall], intent }),
  );
  assert.equal(result.verdict, 'blocked');
});

test('blocks an expired quote deadline', () => {
  const { result } = runSafetyKernel(baseArgs({ quoteExpiry: new Date(NOW.getTime() - 1_000).toISOString() }));
  assert.equal(result.verdict, 'blocked');
});

test('blocks when contract security has no usable GoPlus verdict', () => {
  const { result, contractSecurity } = runSafetyKernel(baseArgs({ contractSecurityResults: [] }));
  assert.equal(result.verdict, 'blocked');
  assert.equal(contractSecurity.status, 'blocked');
});

test('standard verification depth accepts unavailable simulation with a warning-worthy check', () => {
  const intent = makeIntent({ verificationDepth: 'standard' });
  const { result } = runSafetyKernel(
    baseArgs({ intent, calls: [approvalCall(BigInt(intent.amount.amountAtomic)), swapCall()], simulationAcceptable: true }),
  );
  assert.equal(result.verdict, 'allowed');
});

test('enhanced verification depth blocks when simulation evidence is unavailable', () => {
  const intent = makeIntent({ verificationDepth: 'enhanced' });
  const { result } = runSafetyKernel(
    baseArgs({
      intent,
      calls: [approvalCall(BigInt(intent.amount.amountAtomic)), swapCall()],
      simulationAcceptable: false,
      simulationDetail: 'Required simulation evidence unavailable for enhanced verification depth',
    }),
  );
  assert.equal(result.verdict, 'blocked');
});

test('blocks a KyberSwap batch when the router is not pinned', () => {
  const intent = makeIntent();
  const badRouter = '0x2222222222222222222222222222222222222222' as const;
  const { result } = runSafetyKernel(
    baseArgs({
      provider: 'kyberswap',
      routerAddress: badRouter,
      calls: [
        approvalCall(BigInt(intent.amount.amountAtomic), badRouter),
        { ...swapCall(), to: badRouter },
      ],
      intent,
    }),
  );
  assert.equal(result.verdict, 'blocked');
});
