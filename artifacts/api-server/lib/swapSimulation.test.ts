import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { logger } from '@mioagent/utils';
import { hashApprovedCallsV1, type ExecutionCallV1 } from '@mioagent/route-domain';
import type { SimulationProvider } from '@mioagent/paid-intelligence';

import {
  resetSimulationProviderHealthV1,
  simulateSwapCallsV1,
  probeSimulationProviderHealthV1,
  simulationProviderHealthV1,
  swapSimulationCapabilityV1,
} from './swapSimulation.js';

const WALLET = '0x1111111111111111111111111111111111111111' as const;
const ROUTER = '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43' as const;
const NOW = new Date('2026-07-27T10:00:00.000Z');

const CALLS: ExecutionCallV1[] = [
  {
    index: 0,
    callType: 'swap',
    to: ROUTER,
    valueWei: '0',
    data: '0xcac88ea9',
    asset: null,
    amountAtomic: null,
    recipient: WALLET,
    spender: null,
  },
];

function request() {
  return {
    chainId: 8453 as const,
    walletAddress: WALLET,
    blueprintId: 'blueprint:abc',
    callsHash: hashApprovedCallsV1(CALLS),
    calls: CALLS,
  };
}

function provider(body: unknown, ok = true): SimulationProvider {
  return {
    providerId: 'test-provider',
    async simulate() {
      return ok
        ? { ok: true, body }
        : { ok: false, errorCode: 'provider_rpc_error' as const, detail: 'nope' };
    },
  };
}

function failedProvider(errorCode: 'provider_rate_limited' | 'provider_timeout'): SimulationProvider {
  return {
    providerId: 'primary-provider',
    async simulate() {
      return { ok: false, errorCode, detail: 'retryable transport failure' };
    },
  };
}

const SUCCESS_BODY = {
  status: 'success',
  blockNumber: 33_123_456,
  gasUsed: '210000',
  stateChanges: [],
  revertReason: null,
};

describe('the swap simulation is a precondition, so it is honest about not running', () => {
  test('no provider configured is `unavailable`, never a quiet pass', async () => {
    const state = await simulateSwapCallsV1(request(), { provider: null, now: () => NOW });
    assert.equal(state.status, 'unavailable');
    assert.equal(state.errorCode, 'provider_not_configured');
    assert.equal(state.responseHash, null);
    // The request hash is still recorded: what was asked is knowable even when
    // nothing answered.
    assert.ok(state.requestHash);
  });

  test('a transport failure carries the provider error code through', async () => {
    const state = await simulateSwapCallsV1(request(), { provider: provider(null, false), now: () => NOW });
    assert.equal(state.status, 'unavailable');
    assert.equal(state.errorCode, 'provider_rpc_error');
  });

  test('a retryable primary failure uses the explicitly bounded fallback', async () => {
    let fallbackCalls = 0;
    const fallback: SimulationProvider = {
      providerId: 'base-rpc-single-call-v1',
      async simulate(input) {
        fallbackCalls += 1;
        assert.equal(input.calls.length, 1);
        return { ok: true, body: SUCCESS_BODY };
      },
    };
    const state = await simulateSwapCallsV1(request(), {
      provider: failedProvider('provider_rate_limited'),
      fallbackProvider: fallback,
      now: () => NOW,
    });
    assert.equal(state.status, 'passed');
    assert.equal(fallbackCalls, 1);
  });

  test('a non-retryable primary failure is never hidden by a fallback', async () => {
    let fallbackCalls = 0;
    const fallback: SimulationProvider = {
      providerId: 'base-rpc-single-call-v1',
      async simulate() {
        fallbackCalls += 1;
        return { ok: true, body: SUCCESS_BODY };
      },
    };
    const state = await simulateSwapCallsV1(request(), {
      provider: provider(null, false),
      fallbackProvider: fallback,
      now: () => NOW,
    });
    assert.equal(state.status, 'unavailable');
    assert.equal(state.errorCode, 'provider_rpc_error');
    assert.equal(fallbackCalls, 0);
  });

  test('an unreadable response is `unavailable`, not `passed`', async () => {
    const state = await simulateSwapCallsV1(request(), {
      provider: provider({ status: 'success', blockNumber: 1 }),
      now: () => NOW,
    });
    assert.equal(state.status, 'unavailable');
    assert.equal(state.errorCode, 'invalid_response');
  });

  test('a response with no real block is refused', async () => {
    const state = await simulateSwapCallsV1(request(), {
      provider: provider({ ...SUCCESS_BODY, blockNumber: 0 }),
      now: () => NOW,
    });
    assert.equal(state.status, 'unavailable');
  });

  test('a simulated revert is a RESULT — failed, with the block it happened at', async () => {
    const state = await simulateSwapCallsV1(request(), {
      provider: provider({ ...SUCCESS_BODY, status: 'reverted', revertReason: 'INSUFFICIENT_OUTPUT_AMOUNT' }),
      now: () => NOW,
    });
    assert.equal(state.status, 'failed');
    assert.equal(state.errorCode, 'reverted');
    assert.equal(state.blockNumber, '33123456');
    assert.ok(state.responseHash);
  });

  test('a clean run passes and records the block and both hashes', async () => {
    const state = await simulateSwapCallsV1(request(), { provider: provider(SUCCESS_BODY), now: () => NOW });
    assert.equal(state.status, 'passed');
    assert.equal(state.errorCode, null);
    assert.equal(state.blockNumber, '33123456');
    assert.equal(state.observedAt, NOW.toISOString());
    assert.ok(state.requestHash);
    assert.ok(state.responseHash);
  });

  test('the request hash is bound to the calls, so two batches never share one', async () => {
    const first = await simulateSwapCallsV1(request(), { provider: provider(SUCCESS_BODY), now: () => NOW });
    const otherCalls: ExecutionCallV1[] = [{ ...CALLS[0]!, data: '0xdeadbeef' }];
    const second = await simulateSwapCallsV1(
      { ...request(), callsHash: hashApprovedCallsV1(otherCalls), calls: otherCalls },
      { provider: provider(SUCCESS_BODY), now: () => NOW },
    );
    assert.notEqual(first.requestHash, second.requestHash);
  });

  test('only chainId, wallet and the calls are ever sent — no tenant, no prompt, no secret', async () => {
    let seen: unknown = null;
    const spy: SimulationProvider = {
      providerId: 'spy',
      async simulate(input) {
        seen = input;
        return { ok: true, body: SUCCESS_BODY };
      },
    };
    await simulateSwapCallsV1(request(), { provider: spy, now: () => NOW });
    assert.deepEqual(Object.keys(seen as object).sort(), [
      'blueprintHash',
      'calls',
      'callsHash',
      'chainId',
      'walletAddress',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The batch chain.
//
// Production held a valid Alchemy key whose account was out of monthly
// capacity. Every eth_simulateV1 came back 429, the batch claim was demoted,
// and every route whose calldata this server writes reported unavailable —
// while `mainnet.base.org` was sitting there serving the same method for free.
// These tests pin the chain that fixes it, and the health accounting that goes
// with it: one provider's refusal is not the deployment's verdict.
// ---------------------------------------------------------------------------

function failingProvider(providerId: string, errorCode: string): SimulationProvider {
  return {
    providerId,
    async simulate() {
      return { ok: false, errorCode, detail: `${providerId} refused` } as Awaited<
        ReturnType<SimulationProvider['simulate']>
      >;
    },
  };
}

const PASSING_BODY = {
  status: 'success',
  blockNumber: 34_000_001,
  gasUsed: '120000',
  stateChanges: [],
  revertReason: null,
  callResults: [{ index: 0, status: 'success', gasUsed: '120000', revertReason: null, logCount: 0 }],
  failedCallIndex: null,
  assetChanges: { status: 'unavailable', unavailableReason: 'no_logs_emitted', changes: [] },
};

describe('swap simulation batch chain', () => {
  test('an exhausted primary does not condemn the batch claim when the Base RPC answers', async () => {
    resetSimulationProviderHealthV1();
    const batch = { ...provider(PASSING_BODY), providerId: 'base-rpc-eth-simulate-v1' };
    const state = await simulateSwapCallsV1(request(), {
      provider: failingProvider('alchemy-eth-simulate-v1', 'provider_rate_limited'),
      batchFallbackProvider: batch,
      fallbackProvider: null,
      now: () => NOW,
    });
    assert.equal(state.status, 'passed');
    const health = simulationProviderHealthV1();
    // The whole point: capacity exhaustion on ONE endpoint is not a statement
    // about what this deployment can prove.
    assert.equal(health.batchProven, true);
    assert.equal(health.batchProviderId, 'base-rpc-eth-simulate-v1');
  });

  test('the batch claim is disproven only when every batch provider refuses', async () => {
    resetSimulationProviderHealthV1();
    const state = await simulateSwapCallsV1(request(), {
      provider: failingProvider('alchemy-eth-simulate-v1', 'provider_rate_limited'),
      batchFallbackProvider: failingProvider('base-rpc-eth-simulate-v1', 'provider_rate_limited'),
      fallbackProvider: null,
      now: () => NOW,
    });
    assert.equal(state.status, 'unavailable');
    assert.equal(simulationProviderHealthV1().batchProven, false);
  });

  test('an RPC that does not implement eth_simulateV1 falls through to the single-call tier', async () => {
    resetSimulationProviderHealthV1();
    // Infura answers -32601 for eth_simulateV1 on Base, which classifies as
    // provider_method_unsupported. A deployment pointed there still gets its
    // single-call swaps proven rather than a blanket "no provider answered".
    const state = await simulateSwapCallsV1(request(), {
      provider: null,
      batchFallbackProvider: failingProvider('base-rpc-eth-simulate-v1', 'provider_method_unsupported'),
      fallbackProvider: { ...provider(PASSING_BODY), providerId: 'base-rpc-single-call-v1' },
      now: () => NOW,
    });
    assert.equal(state.status, 'passed');
  });

  test('a revert from the first provider is a result, never retried on the next', async () => {
    resetSimulationProviderHealthV1();
    let secondCalls = 0;
    const second: SimulationProvider = {
      providerId: 'base-rpc-eth-simulate-v1',
      async simulate() {
        secondCalls += 1;
        return { ok: true, body: PASSING_BODY } as Awaited<ReturnType<SimulationProvider['simulate']>>;
      },
    };
    const state = await simulateSwapCallsV1(request(), {
      provider: provider({ ...PASSING_BODY, status: 'reverted', revertReason: 'STF', failedCallIndex: 0 }),
      batchFallbackProvider: second,
      fallbackProvider: null,
      now: () => NOW,
    });
    assert.equal(state.status, 'failed');
    assert.equal(secondCalls, 0, 'a revert must not be shopped around until some provider likes it');
  });
});

describe('swapSimulationCapabilityV1', () => {
  test('a Base RPC alone is a batch simulator — no paid key required', () => {
    resetSimulationProviderHealthV1();
    const capability = swapSimulationCapabilityV1({
      BASE_MAINNET_RPC_URL: 'https://mainnet.base.org',
    } as NodeJS.ProcessEnv);
    assert.equal(capability.batch, true);
    assert.equal(capability.singleCall, true);
    // No primary is configured, and that is no longer the same as no batch.
    assert.equal(capability.primaryProviderId, null);
  });

  test('an unconfigured deployment still has Base\'s own endpoint', () => {
    resetSimulationProviderHealthV1();
    // This assertion used to read `false` for both. The public Base endpoint is
    // a code-owned constant now, so simulation capability no longer depends on
    // an operator having configured anything — and the claim is still measured,
    // not assumed: the boot probe demotes it the moment a real call fails.
    const capability = swapSimulationCapabilityV1({} as NodeJS.ProcessEnv);
    assert.equal(capability.batch, true);
    assert.equal(capability.singleCall, true);
    assert.equal(capability.primaryProviderId, null);
  });

  test('a measured refusal still demotes the claim', async () => {
    resetSimulationProviderHealthV1();
    const env = { BASE_MAINNET_RPC_URL: 'https://mainnet.base.org' } as NodeJS.ProcessEnv;
    assert.equal(swapSimulationCapabilityV1(env).batch, true);
    // Configuration alone never restores a claim a real attempt disproved.
    await simulateSwapCallsV1(request(), {
      provider: failingProvider('alchemy-eth-simulate-v1', 'provider_rate_limited'),
      batchFallbackProvider: failingProvider('base-rpc-eth-simulate-v1', 'provider_rate_limited'),
      fallbackProvider: null,
      now: () => NOW,
    });
    assert.equal(swapSimulationCapabilityV1(env).batch, false);
  });
});

describe('the simulation endpoint is chosen independently of the read endpoint', () => {
  test('an Infura read RPC still leaves a batch simulator available', () => {
    resetSimulationProviderHealthV1();
    // Production's BASE_MAINNET_RPC_URL is Infura on purpose (daily quota reset
    // beats a monthly one for the user-facing read path). Infura answers -32601
    // for eth_simulateV1, so inheriting it for simulation reported "only a
    // single-call simulator is configured" and took four providers' routes down.
    const capability = swapSimulationCapabilityV1({
      BASE_MAINNET_RPC_URL: 'https://base-mainnet.infura.io/v3/project',
    } as NodeJS.ProcessEnv);
    assert.equal(capability.batch, true);
  });

  test('an explicit MIORAIL_SIMULATION_RPC_URL is honoured over the read RPC', () => {
    resetSimulationProviderHealthV1();
    const capability = swapSimulationCapabilityV1({
      BASE_MAINNET_RPC_URL: 'https://base-mainnet.infura.io/v3/project',
      MIORAIL_SIMULATION_RPC_URL: 'https://mainnet.base.org',
    } as NodeJS.ProcessEnv);
    assert.equal(capability.batch, true);
  });

  test('the public endpoint is not added twice when it is already the configured one', async () => {
    resetSimulationProviderHealthV1();
    // Same URL, so the chain must hold one provider for it — asking the same
    // endpoint twice is not a fallback, it is a retry wearing a second name.
    const seen: string[] = [];
    const record = (providerId: string): SimulationProvider => ({
      providerId,
      async simulate() {
        seen.push(providerId);
        return { ok: false, errorCode: 'provider_rate_limited', detail: 'x' } as Awaited<
          ReturnType<SimulationProvider['simulate']>
        >;
      },
    });
    await simulateSwapCallsV1(request(), {
      provider: record('base-rpc-eth-simulate-v1'),
      batchFallbackProvider: record('base-rpc-eth-simulate-v1'),
      fallbackProvider: null,
      now: () => NOW,
    });
    assert.deepEqual(seen, ['base-rpc-eth-simulate-v1']);
  });
});

describe('the boot probe reports through one channel', () => {
  const originalFetch = globalThis.fetch;
  const originalInfo = logger.info.bind(logger);
  const originalWarn = logger.warn.bind(logger);

  const restore = () => {
    globalThis.fetch = originalFetch;
    logger.info = originalInfo;
    logger.warn = originalWarn;
  };

  const jsonResponse = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  test('a refusal and the answer that followed it are both structured', async () => {
    resetSimulationProviderHealthV1();
    const infos: Array<{ message: string; meta: Record<string, unknown> }> = [];
    const warns: Array<{ message: string; meta: Record<string, unknown> }> = [];
    logger.info = ((message: string, meta?: Record<string, unknown>) => {
      infos.push({ message, meta: meta ?? {} });
    }) as typeof logger.info;
    logger.warn = ((message: string, meta?: Record<string, unknown>) => {
      warns.push({ message, meta: meta ?? {} });
    }) as typeof logger.warn;

    // The production shape exactly: the configured read RPC cannot serve
    // eth_simulateV1 (Infura answers -32601), and Base's own endpoint can.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      // The id must be echoed: the adapter refuses a reply it did not ask for,
      // and a mock that ignores that tests a path production never takes.
      const id = JSON.parse(String(init?.body ?? '{}')).id as string;
      if (url.includes('mainnet.base.org')) {
        return jsonResponse({
          jsonrpc: '2.0',
          id,
          result: [
            {
              number: '0x2071e81',
              calls: [{ status: '0x1', gasUsed: '0x5e0f', returnData: '0x', logs: [] }],
            },
          ],
        });
      }
      return jsonResponse({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
    }) as typeof fetch;

    try {
      const health = await probeSimulationProviderHealthV1({
        BASE_MAINNET_RPC_URL: 'https://read-only.example/v3/key',
      } as NodeJS.ProcessEnv);

      assert.equal(health.batchProven, true);
      assert.equal(health.batchProviderId, 'base-public-eth-simulate-v1');

      // The refusal says which KIND it is. An endpoint that does not implement
      // the method will refuse identically at every boot forever, and calling
      // that an incident sends an operator after a permanent line.
      const refusal = warns.find((entry) => entry.message.includes('did not answer'));
      assert.equal(refusal?.meta.provider, 'base-rpc-eth-simulate-v1');
      assert.equal(refusal?.meta.errorCode, 'provider_method_unsupported');
      assert.equal(refusal?.meta.permanent, true);

      // And the verdict goes through the SAME channel. It used to be a bare
      // console line while the refusals were structured, so anything reading
      // levels saw two warnings and never saw that a later provider answered —
      // which is how a working deployment gets read as having no simulator.
      const verdict = infos.find((entry) => entry.message.includes('probe answered'));
      assert.equal(verdict?.meta.provider, 'base-public-eth-simulate-v1');
      assert.deepEqual(verdict?.meta.refusedBefore, ['base-rpc-eth-simulate-v1']);
    } finally {
      restore();
    }
  });
});
