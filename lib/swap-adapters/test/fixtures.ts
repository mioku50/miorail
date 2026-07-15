import { resolveRouteAssetV1 } from '@mioagent/intent-engine';
import {
  RouteIntentV1Schema,
  ZERO_HASH_V1,
  hashRouteIntentV1,
  type RouteIntentV1,
} from '@mioagent/route-domain';
import type {
  BaseMcpSkillExecutor,
  PluginHttpResponse,
} from '@mioagent/runtime-skills';
import {
  KYBERSWAP_BASE_ROUTER,
  KYBERSWAP_NATIVE_ETH,
  UNISWAP_NATIVE_ETH,
  basisPointsToPercentage,
  humanDecimalToAtomic,
  providerTokenAddress,
} from '../src/index.js';

export const NOW = new Date('2026-07-15T12:00:00.000Z');
export const EXPIRES = '2026-07-15T12:00:30.000Z';
export const WALLET = '0x1111111111111111111111111111111111111111' as const;
export const POOL = '0x2222222222222222222222222222222222222222' as const;

type IntentOverrides = Partial<
  Pick<RouteIntentV1, 'protocolConstraint' | 'slippageConstraint' | 'status' | 'chainId'>
> & {
  from?: 'USDC' | 'ETH' | 'WETH';
  to?: 'USDC' | 'ETH' | 'WETH';
  amount?: string;
};

export function makeIntent(overrides: IntentOverrides = {}): RouteIntentV1 {
  const fromAsset = resolveRouteAssetV1(overrides.from ?? 'USDC')!;
  const toAsset = resolveRouteAssetV1(overrides.to ?? 'ETH')!;
  const amountDecimal = overrides.amount ?? (fromAsset.symbol === 'USDC' ? '100' : '0.5');
  const amountAtomic = humanDecimalToAtomic(amountDecimal, fromAsset.decimals)!;
  const draft: RouteIntentV1 = {
    schemaVersion: 'route-intent/v1',
    id: 'intent-t53-fixture',
    tenantId: 'tenant-t53',
    walletAddress: WALLET,
    chainId: overrides.chainId ?? 8453,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    status: overrides.status ?? 'ready',
    intentHash: ZERO_HASH_V1,
    goal: 'swap',
    fromAsset,
    toAsset,
    amount: { asset: fromAsset, amountAtomic, amountDecimal },
    optimizationMode: 'best_net_result',
    verificationDepth: 'standard',
    protocolConstraint: overrides.protocolConstraint ?? { mode: 'any', protocols: [] },
    slippageConstraint: overrides.slippageConstraint ?? { maxBps: 50, source: 'user' },
    executionRequested: false,
  };
  const value = { ...draft, intentHash: hashRouteIntentV1(draft) };
  return overrides.chainId && overrides.chainId !== 8453 ? value : RouteIntentV1Schema.parse(value);
}

export function withProtocolConstraint(
  intent: RouteIntentV1,
  protocolConstraint: RouteIntentV1['protocolConstraint'],
): RouteIntentV1 {
  const draft = { ...intent, protocolConstraint, intentHash: ZERO_HASH_V1 };
  return RouteIntentV1Schema.parse({ ...draft, intentHash: hashRouteIntentV1(draft) });
}

export function uniswapResponse(
  intent: RouteIntentV1,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const tokenIn = providerTokenAddress(intent.fromAsset!, 'uniswap')!;
  const tokenOut = providerTokenAddress(intent.toAsset!, 'uniswap')!;
  const output = intent.toAsset!.symbol === 'USDC' ? '1250000000' : '38000000000000000';
  return {
    routing: 'CLASSIC',
    quoteId: 'uniswap-quote-t53',
    quote: {
      input: { amount: intent.amount.amountAtomic, token: tokenIn },
      output: { amount: output, token: tokenOut },
      gasUseEstimate: '190000',
      gasFee: '285000000000000',
      classicGasUseEstimateUSD: '0.71',
      priceImpact: '0.08',
      slippageTolerance: basisPointsToPercentage(intent.slippageConstraint.maxBps),
      observedAt: NOW.toISOString(),
      expiresAt: EXPIRES,
      blockNumber: '33123456',
      route: [{ protocol: 'uniswap-v3', poolAddress: POOL, feeBps: '5' }],
      transaction: { data: '0xshould-not-leak' },
      ...overrides,
    },
    permitData: { signature: 'secret-should-not-leak' },
  };
}

export function kyberResponse(
  intent: RouteIntentV1,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const tokenIn = providerTokenAddress(intent.fromAsset!, 'kyberswap')!;
  const tokenOut = providerTokenAddress(intent.toAsset!, 'kyberswap')!;
  const output = intent.toAsset!.symbol === 'USDC' ? '1252000000' : '38100000000000000';
  return {
    data: {
      routerAddress: KYBERSWAP_BASE_ROUTER,
      routeSummary: {
        routeId: 'kyber-route-t53',
        chainId: 8453,
        tokenIn,
        tokenOut,
        amountIn: intent.amount.amountAtomic,
        amountOut: output,
        gas: '210000',
        gasUsd: '0.79',
        priceImpact: '0.09',
        observedAt: NOW.toISOString(),
        expiresAt: EXPIRES,
        blockNumber: '33123456',
        route: [[{ exchange: 'uniswap-v3', poolAddress: POOL, feeBps: '5' }]],
        ...overrides,
      },
    },
  };
}

export function responseFetch(
  payload: unknown,
  status = 200,
  observe?: (url: string, init?: RequestInit) => void,
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    observe?.(String(url), init);
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

export function mockKyberExecutor(
  response:
    | PluginHttpResponse
    | ((input: Parameters<BaseMcpSkillExecutor['request']>[0]) => Promise<PluginHttpResponse>),
): BaseMcpSkillExecutor {
  return {
    namespace: 'kyberswap',
    manifest: {
      integration: 'http-api',
      chains: [8453],
      allowlist: {
        hosts: ['aggregator-api.kyberswap.com'],
        methods: ['GET'],
        pathPrefixes: ['/base/api/v1/routes'],
      },
      auth: 'none',
      risk: ['slippage', 'aggregated-route'],
    },
    allowedPaths: ['/base/api/v1/routes'],
    request: typeof response === 'function' ? response : async () => response,
  };
}

export { KYBERSWAP_BASE_ROUTER, KYBERSWAP_NATIVE_ETH, UNISWAP_NATIVE_ETH };
