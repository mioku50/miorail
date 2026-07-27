import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { hashApprovedCallsV1, type ExecutionCallV1 } from '@mioagent/route-domain';
import type { SimulationProvider } from '@mioagent/paid-intelligence';

import { simulateSwapCallsV1 } from './swapSimulation.js';

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
