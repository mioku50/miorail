import type { IntentRuntimeContextV2, SwapIntentExtractionV2 } from '../src/index.js';

export const TEST_TENANT = 'intent-engine-tenant';
export const TEST_WALLET = '0x1111111111111111111111111111111111111111';
export const OTHER_WALLET = '0x2222222222222222222222222222222222222222';
export const TEST_TIME = '2026-07-15T12:00:00.000Z';

export function testContext(
  overrides: Partial<IntentRuntimeContextV2> = {},
): IntentRuntimeContextV2 {
  return {
    tenantId: TEST_TENANT,
    walletAddress: TEST_WALLET,
    runtimeChainId: 8453,
    requestId: 'request-fixture-1',
    requestedAt: TEST_TIME,
    recentMessages: [],
    pendingIntents: [],
    ...overrides,
  };
}

export function swapExtraction(
  overrides: Partial<SwapIntentExtractionV2> = {},
): SwapIntentExtractionV2 {
  return {
    goal: 'swap',
    amount: '100',
    fromAsset: 'USDC',
    toAsset: 'ETH',
    chainId: null,
    ...overrides,
  };
}
