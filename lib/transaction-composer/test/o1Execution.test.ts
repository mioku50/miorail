import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  maxUint256,
  parseAbi,
  serializeTransaction,
  zeroHash,
  type Hex,
} from 'viem';
import { O1_ZEROX_ALLOWANCE_HOLDER, O1_ZEROX_SETTLER_EXECUTE_SELECTOR } from '@mioagent/security/o1Guard';
import {
  O1_ZEROX_ALLOWANCE_HOLDER_V1,
  O1_ZEROX_EXEC_ABI_V1,
  O1_ZEROX_SETTLER_EXECUTE_SELECTOR_V1,
  O1SwapRouteAdapter,
  type O1OrderRequestV1,
  type O1RouterPinReaderV1,
} from '@mioagent/swap-adapters';

import { O1SwapBuildAdapter } from '../src/adapters/o1.js';
import { classifySwapCallV1 } from '../src/blueprint.js';
import { o1SettlerFromCandidateV1 } from '../src/coordinator.js';
import { runSafetyKernel } from '../src/safetyKernel.js';
import { NOW, USDC_BASE, WALLET, WETH_BASE, makeIntent } from './fixtures.js';

const USDC = USDC_BASE.address as `0x${string}`;
const WETH = WETH_BASE.address as `0x${string}`;
const SETTLER = '0x2222222222222222222222222222222222222222' as const;
const PREVIOUS_SETTLER = '0x3333333333333333333333333333333333333333' as const;
const AMOUNT_IN = 100_000_000n;
const MINIMUM_OUT = 37_810_000_000_000_000n;

const SETTLER_ABI = parseAbi([
  'function execute((address recipient, address buyToken, uint256 minAmountOut) slippage, bytes[] actions, bytes32 zid) payable returns (bool)',
]);

const pin: O1RouterPinReaderV1 = {
  async verify() {
    return { ok: true, blockNumber: '56131136', settlers: [SETTLER, PREVIOUS_SETTLER] };
  },
};

function raw(to: `0x${string}`, data: Hex, gas: bigint): Hex {
  return serializeTransaction({
    chainId: 8453,
    type: 'eip1559',
    nonce: 0,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 0n,
    gas,
    to,
    value: 0n,
    data,
  });
}

/** An order as o1 answers today: an unlimited approval to AllowanceHolder, then `exec` running a Settler. */
function payload(request: O1OrderRequestV1, settler: `0x${string}` = SETTLER) {
  const inner = encodeFunctionData({
    abi: SETTLER_ABI,
    functionName: 'execute',
    args: [{ recipient: WALLET, buyToken: WETH, minAmountOut: MINIMUM_OUT }, ['0xc1fb425eaa', '0x38c9c147bb'], zeroHash],
  });
  const swap = encodeFunctionData({
    abi: O1_ZEROX_EXEC_ABI_V1,
    functionName: 'exec',
    args: [settler, USDC, AMOUNT_IN, settler, inner],
  });
  return {
    success: true,
    id: `order-${settler}`,
    order: request,
    transactions: [
      {
        id: 'approve',
        unsigned: raw(
          USDC,
          encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [O1_ZEROX_ALLOWANCE_HOLDER_V1, maxUint256],
          }),
          100_000n,
        ),
      },
      { id: 'swap', unsigned: raw(O1_ZEROX_ALLOWANCE_HOLDER_V1, swap, 230_466n) },
    ],
  };
}

function fetchFor(settler: `0x${string}` = SETTLER): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as O1OrderRequestV1;
    return new Response(JSON.stringify(payload(request, settler)), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

async function quoteAndBuild(buildSettler: `0x${string}` = SETTLER) {
  const intent = makeIntent({ toAsset: WETH_BASE });
  const quote = await new O1SwapRouteAdapter({
    sharedToken: 'fixture',
    pinReader: pin,
    fetchImpl: fetchFor(),
  }).quote({ intent, walletAddress: WALLET, requestId: 'quote-o1', now: NOW });
  assert.equal(quote.outcome, 'quoted');
  if (quote.outcome !== 'quoted') throw new Error('not quoted');
  const result = await new O1SwapBuildAdapter({
    sharedToken: 'fixture',
    pinReader: pin,
    fetchImpl: fetchFor(buildSettler),
  }).build({
    intent,
    selectedCandidate: quote.candidate,
    reviewedCandidate: quote.candidate,
    walletAddress: WALLET,
    requestId: 'build-o1',
    now: NOW,
  });
  return { intent, candidate: quote.candidate, result };
}

describe('o1 build adapter', () => {
  test('replaces provider unlimited approval with the exact reviewed amount', async () => {
    const { result } = await quoteAndBuild();
    assert.equal(result.outcome, 'built');
    if (result.outcome !== 'built') return;
    assert.equal(result.calls.length, 2);
    assert.equal(result.calls[0]!.to, USDC);
    assert.equal(result.calls[1]!.to, O1_ZEROX_ALLOWANCE_HOLDER_V1);
    assert.equal(result.routerAddress, O1_ZEROX_ALLOWANCE_HOLDER_V1);
    const approval = decodeFunctionData({ abi: erc20Abi, data: result.calls[0]!.data });
    assert.equal(approval.functionName, 'approve');
    if (approval.functionName !== 'approve') return;
    assert.equal(approval.args[0].toLowerCase(), O1_ZEROX_ALLOWANCE_HOLDER_V1);
    assert.equal(approval.args[1], AMOUNT_IN);
    // What the registry named during this build travels with it to the kernel.
    assert.deepEqual(result.o1, { contractPinVerified: true, settlers: [SETTLER, PREVIOUS_SETTLER] });
  });

  test('forces a fresh review when the order settles through another Settler than the one quoted', async () => {
    const { result } = await quoteAndBuild(PREVIOUS_SETTLER);
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.errorCode, 'o1_route_changed');
  });

  test('a candidate names the Settler it settles through, and nothing else is read as one', async () => {
    const { candidate } = await quoteAndBuild();
    assert.equal(o1SettlerFromCandidateV1(candidate), SETTLER);
    const source = candidate.liquiditySources[0]!;
    assert.equal(o1SettlerFromCandidateV1({ ...candidate, liquiditySources: [] }), null);
    assert.equal(o1SettlerFromCandidateV1({ ...candidate, liquiditySources: [source, source] }), null);
    assert.equal(
      o1SettlerFromCandidateV1({ ...candidate, liquiditySources: [{ ...source, sourceKey: `eip155:8453/hydrex:zerox:${SETTLER}` }] }),
      null,
    );
    assert.equal(
      o1SettlerFromCandidateV1({ ...candidate, liquiditySources: [{ ...source, sourceKey: 'eip155:8453/o1-exchange:zerox:0x1234' }] }),
      null,
    );
  });
});

describe('the Safety Kernel on an o1 batch', () => {
  async function kernel(overrides: Partial<Parameters<typeof runSafetyKernel>[0]> = {}) {
    const { intent, candidate, result } = await quoteAndBuild();
    assert.equal(result.outcome, 'built');
    if (result.outcome !== 'built') throw new Error('not built');
    const calls = result.calls.map((call, index) =>
      classifySwapCallV1({ index, call, routerAddress: result.routerAddress, inputAsset: USDC_BASE, walletAddress: WALLET }),
    );
    return runSafetyKernel({
      provider: 'o1-exchange',
      routerAddress: result.routerAddress,
      chainId: 8453,
      walletAddress: WALLET,
      intent,
      calls,
      quoteExpiry: result.quoteExpiry,
      now: NOW,
      contractSecurityRequired: true,
      contractSecurityProvider: 'goplus',
      contractSecurityResults: [
        { address: USDC, provider: 'goplus' as const, status: 'ok' as const, summary: 'clean' },
        { address: WETH, provider: 'goplus' as const, status: 'ok' as const, summary: 'clean' },
      ],
      contractSecurityAddresses: [USDC, WETH],
      simulationAcceptable: true,
      simulationDetail: 'ok',
      intentHash: intent.intentHash,
      selectedCandidateHash: candidate.candidateHash,
      reviewedMinimumOutputAtomic: candidate.minimumOutput.amountAtomic,
      o1ContractPinVerified: result.o1?.contractPinVerified,
      o1Settlers: result.o1?.settlers,
      ...overrides,
    }).result;
  }
  const failed = (result: Awaited<ReturnType<typeof kernel>>) =>
    result.checks.filter((entry) => entry.status === 'failed').map((entry) => entry.id);

  test('allows the built batch with what the build read from the chain', async () => {
    const result = await kernel();
    assert.deepEqual(failed(result), []);
    assert.equal(result.verdict, 'allowed');
  });

  test('at approval the one Settler the candidate names is enough, once the registry confirmed it', async () => {
    const result = await kernel({ o1Settlers: [SETTLER] });
    assert.equal(result.verdict, 'allowed');
  });

  test('blocks when the registry was not read, or no longer names the Settler', async () => {
    const unread = await kernel({ o1ContractPinVerified: false });
    assert.equal(unread.verdict, 'blocked');
    assert.deepEqual(failed(unread), ['provider_contract_pin_o1']);

    const noSettlers = await kernel({ o1Settlers: undefined });
    assert.equal(noSettlers.verdict, 'blocked');
    assert.deepEqual(failed(noSettlers), ['provider_guard_o1']);

    const another = await kernel({ o1Settlers: [PREVIOUS_SETTLER] });
    assert.equal(another.verdict, 'blocked');
    assert.deepEqual(failed(another), ['provider_guard_o1']);
  });

  test('blocks a floor weaker than the one on the Route Card', async () => {
    const result = await kernel({ reviewedMinimumOutputAtomic: (MINIMUM_OUT + 1n).toString() });
    assert.equal(result.verdict, 'blocked');
    assert.deepEqual(failed(result), ['provider_guard_o1']);
  });
});

describe('the two packages pin the same bytes', () => {
  test('AllowanceHolder and the Settler selector are equal in swap-adapters and security', () => {
    assert.equal(O1_ZEROX_ALLOWANCE_HOLDER, O1_ZEROX_ALLOWANCE_HOLDER_V1);
    assert.equal(O1_ZEROX_SETTLER_EXECUTE_SELECTOR, O1_ZEROX_SETTLER_EXECUTE_SELECTOR_V1);
  });
});
