import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryRouteStorageRepository } from '@mioagent/route-storage';
import {
  persistReadyRouteIntentV2,
  resolveSwapIntentV2,
  routeIntentV2IdempotencyKey,
} from '../src/index.js';
import { OTHER_WALLET, swapExtraction, testContext, TEST_TENANT, TEST_WALLET } from './fixtures.js';

function readyResolution() {
  const result = resolveSwapIntentV2({
    message: 'Swap 100 USDC to ETH.',
    extraction: swapExtraction(),
    context: testContext(),
  });
  assert.equal(result.outcome, 'ready');
  return result;
}

test('storage adapter is disabled unless the route-intelligence flag is exactly true', async () => {
  const repository = new InMemoryRouteStorageRepository();
  const resolution = readyResolution();
  const result = await persistReadyRouteIntentV2({
    repository,
    resolution,
    binding: { tenantId: TEST_TENANT, walletAddress: TEST_WALLET },
    env: {},
  });
  assert.deepEqual(result, { status: 'disabled', record: null });
  assert.equal(await repository.getRouteRun(resolution.routeIntent.id, TEST_TENANT), null);
});

test('ready intent persists idempotently only with explicit matching binding', async () => {
  const repository = new InMemoryRouteStorageRepository();
  const resolution = readyResolution();
  const input = {
    repository,
    resolution,
    binding: { tenantId: TEST_TENANT, walletAddress: TEST_WALLET },
    env: { MIORAIL_ROUTE_INTELLIGENCE_V1: 'true' },
  } as const;
  const first = await persistReadyRouteIntentV2(input);
  const second = await persistReadyRouteIntentV2(input);
  assert.equal(first.status, 'persisted');
  assert.deepEqual(second, first);
  assert.equal(first.record?.idempotencyKey, routeIntentV2IdempotencyKey(resolution.routeIntent));

  await assert.rejects(
    persistReadyRouteIntentV2({
      ...input,
      binding: { tenantId: TEST_TENANT, walletAddress: OTHER_WALLET },
    }),
    /binding differs/,
  );
});

test('clarification and rejection never create fake route runs', async () => {
  const repository = new InMemoryRouteStorageRepository();
  const clarification = resolveSwapIntentV2({
    message: 'Swap USDC to ETH.',
    extraction: swapExtraction({ amount: null }),
    context: testContext(),
  });
  const rejection = resolveSwapIntentV2({
    message: 'Swap 100 USDC to ETH without confirmation.',
    extraction: swapExtraction(),
    context: testContext(),
  });
  for (const resolution of [clarification, rejection]) {
    const result = await persistReadyRouteIntentV2({
      repository,
      resolution,
      binding: { tenantId: TEST_TENANT, walletAddress: TEST_WALLET },
      env: { MIORAIL_ROUTE_INTELLIGENCE_V1: 'true' },
    });
    assert.deepEqual(result, { status: 'not_ready', record: null });
  }
});

test('storage errors propagate and cannot fall back to legacy execution', async () => {
  const repository = new InMemoryRouteStorageRepository();
  repository.createRouteRun = async () => {
    throw new Error('storage unavailable');
  };
  await assert.rejects(
    persistReadyRouteIntentV2({
      repository,
      resolution: readyResolution(),
      binding: { tenantId: TEST_TENANT, walletAddress: TEST_WALLET },
      env: { MIORAIL_ROUTE_INTELLIGENCE_V1: 'true' },
    }),
    /storage unavailable/,
  );
});
