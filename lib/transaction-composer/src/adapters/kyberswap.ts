import { encodeFunctionData, erc20Abi } from 'viem';
import { canonicalUsdcForBaseChain } from '@mioagent/security/baseGuards';
import { loadSkillExecutor, type BaseMcpSkillExecutor } from '@mioagent/runtime-skills';
import {
  KYBERSWAP_BASE_ROUTER,
  atomicToHumanDecimal,
  canonicalRequestHash,
  canonicalResponseHash,
  minimumOutputAtomic,
  normalizeAddress,
  parsePositiveAtomic,
  providerTokenAddress,
} from '@mioagent/swap-adapters';
import type { TokenAmountV1 } from '@mioagent/route-domain';
import type {
  SwapBuildAdapter,
  SwapBuildCallV1,
  SwapBuildFailure,
  SwapBuildFailureOutcome,
  SwapBuildInput,
  SwapBuildResultV1,
} from '../types.js';

const CANONICAL_USDC_BASE_V1 = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const CANONICAL_WETH_BASE_V1 = '0x4200000000000000000000000000000000000006';

function failure(outcome: SwapBuildFailureOutcome, errorCode: string, retryable: boolean): SwapBuildFailure {
  return { outcome, provider: 'kyberswap', errorCode, retryable };
}

export interface KyberSwapBuildAdapterOptions {
  executorFactory?: () => BaseMcpSkillExecutor | null;
}

/**
 * T56: builds exact unsigned KyberSwap calls for an explicitly selected
 * candidate. GET routes -> POST route/build via the manifest-gated skill
 * executor only; the routeSummary is passed to route/build byte-preserved.
 * The exact-amount USDC approval is constructed here (KyberSwap's build
 * response never includes it), targeting the router the build response
 * itself returned — never an address chosen by response labels alone.
 */
export class KyberSwapBuildAdapter implements SwapBuildAdapter {
  readonly id = 'kyberswap' as const;
  private readonly executorFactory: () => BaseMcpSkillExecutor | null;

  constructor(options: KyberSwapBuildAdapterOptions = {}) {
    this.executorFactory = options.executorFactory ?? (() => loadSkillExecutor('kyberswap'));
  }

  async build(input: SwapBuildInput): Promise<SwapBuildResultV1> {
    const { intent } = input;
    // Both directions between the canonical Base assets — the USDC-in rule was
    // this adapter's, not KyberSwap's. ETH↔WETH stays out: a wrap is not a
    // routed trade. Identified by ADDRESS; a symbol is a label anyone can take.
    const sideOf = (asset: typeof intent.fromAsset) => {
      if (!asset) return null;
      if (asset.kind === 'native') return 'weth' as const;
      const address = asset.address?.toLowerCase();
      if (address === CANONICAL_USDC_BASE_V1) return 'usdc' as const;
      if (address === CANONICAL_WETH_BASE_V1) return 'weth' as const;
      return null;
    };
    const fromSide = sideOf(intent.fromAsset);
    const toSide = sideOf(intent.toAsset);
    if (intent.chainId !== 8453 || !fromSide || !toSide || fromSide === toSide) {
      return failure('rejected', 'kyberswap_pair_unsupported', false);
    }
    const inputIsNative = intent.fromAsset?.kind === 'native';
    if (input.walletAddress.toLowerCase() !== intent.walletAddress.toLowerCase()) {
      return failure('rejected', 'kyberswap_wallet_mismatch', false);
    }
    const executor = this.executorFactory();
    if (!executor || executor.namespace !== 'kyberswap') {
      return failure('not_configured', 'kyberswap_not_configured', false);
    }
    const tokenIn = providerTokenAddress(intent.fromAsset!, 'kyberswap');
    const tokenOut = providerTokenAddress(intent.toAsset!, 'kyberswap');
    if (!tokenIn || !tokenOut) return failure('rejected', 'kyberswap_asset_untrusted', false);

    const routesParams = new URLSearchParams([
      ['tokenIn', tokenIn],
      ['tokenOut', tokenOut],
      ['amountIn', intent.amount.amountAtomic],
      ['to', input.walletAddress],
      ['slippageTolerance', String(intent.slippageConstraint.maxBps)],
      ['source', 'miorail'],
    ]);
    const routesPath = `/base/api/v1/routes?${routesParams.toString()}`;

    let routesResponse;
    try {
      routesResponse = await executor.request({ path: routesPath, method: 'GET', chainId: 8453 });
    } catch {
      return failure('unavailable', 'kyberswap_routes_unreachable', true);
    }
    if (routesResponse.status === 404) return failure('unavailable', 'kyberswap_no_route', false);
    if (routesResponse.status === 429) return failure('rate_limited', 'kyberswap_rate_limited', true);
    if (routesResponse.status < 200 || routesResponse.status >= 300) {
      return failure('unavailable', `kyberswap_http_${routesResponse.status}`, true);
    }
    const routesRecord = asRecord(routesResponse.data);
    const routesData = routesRecord && asRecord(routesRecord.data);
    const routeSummary = routesData?.routeSummary;
    const quotedRouter = routesData ? normalizeAddress(routesData.routerAddress) : null;
    if (!routeSummary || typeof routeSummary !== 'object' || !quotedRouter) {
      return failure('invalid_response', 'kyberswap_routes_invalid', false);
    }
    if (quotedRouter !== KYBERSWAP_BASE_ROUTER) return failure('router_mismatch', 'kyberswap_router_mismatch', false);

    // Build-side outputs come from the exact routeSummary that is POSTed to
    // route/build below — the same object the calldata is generated from.
    // Minimum = amountOut bounded by the stored intent's slippage constraint,
    // matching how the quote adapter already derives candidate outputs.
    const summaryRecord = routeSummary as Record<string, unknown>;
    const buildAmountOut = parsePositiveAtomic(summaryRecord.amountOut);
    if (!buildAmountOut) return failure('invalid_response', 'kyberswap_routes_invalid', false);
    const buildMinimumAtomic = minimumOutputAtomic(buildAmountOut, intent.slippageConstraint.maxBps);
    const buildExpectedDecimal = atomicToHumanDecimal(buildAmountOut, intent.toAsset!.decimals);
    const buildMinimumDecimal = atomicToHumanDecimal(buildMinimumAtomic, intent.toAsset!.decimals);
    if (buildExpectedDecimal === null || buildMinimumDecimal === null) {
      return failure('invalid_response', 'kyberswap_routes_invalid', false);
    }
    const expectedOutput: TokenAmountV1 = {
      asset: intent.toAsset!,
      amountAtomic: buildAmountOut,
      amountDecimal: buildExpectedDecimal,
    };
    const minimumOutput: TokenAmountV1 = {
      asset: intent.toAsset!,
      amountAtomic: buildMinimumAtomic,
      amountDecimal: buildMinimumDecimal,
    };

    const deadline = Math.floor((input.now.getTime() + 10 * 60_000) / 1000);
    const quoteExpiry = new Date(deadline * 1000).toISOString();
    const buildBody = {
      routeSummary,
      sender: input.walletAddress,
      recipient: input.walletAddress,
      slippageTolerance: intent.slippageConstraint.maxBps,
      deadline,
      source: 'miorail',
    };

    let buildResponse;
    try {
      buildResponse = await executor.request({
        path: '/base/api/v1/route/build',
        method: 'POST',
        body: buildBody,
        chainId: 8453,
      });
    } catch {
      return failure('unavailable', 'kyberswap_build_unreachable', true);
    }
    if (buildResponse.status < 200 || buildResponse.status >= 300) {
      return failure('unavailable', `kyberswap_http_${buildResponse.status}`, true);
    }
    const buildRecord = asRecord(buildResponse.data);
    const buildData = buildRecord && asRecord(buildRecord.data);
    const builtRouter = buildData ? normalizeAddress(buildData.routerAddress) : null;
    const calldata = buildData?.data;
    const transactionValue = String(buildData?.transactionValue ?? buildData?.value ?? '0');
    if (
      !builtRouter ||
      builtRouter !== KYBERSWAP_BASE_ROUTER ||
      typeof calldata !== 'string' ||
      !/^0x(?:[0-9a-fA-F]{2})*$/.test(calldata)
    ) {
      return failure('invalid_response', 'kyberswap_build_invalid', false);
    }
    // A native input MUST attach exactly the input amount; an ERC-20 input must
    // attach nothing. The provider's own figure has to agree with the intent,
    // or the value moved is not the value that was reviewed.
    const expectedValue = inputIsNative ? intent.amount.amountAtomic : '0';
    if (transactionValue !== expectedValue) {
      return failure('rejected', 'kyberswap_native_value_mismatch', false);
    }

    // Native ETH has nothing to approve, so that batch is the router call
    // alone. An ERC-20 input approves its OWN token, exactly.
    const inputToken = (
      intent.fromAsset?.address ?? canonicalUsdcForBaseChain(8453)
    ).toLowerCase() as `0x${string}`;
    const calls: SwapBuildCallV1[] = inputIsNative
      ? [
          {
            to: builtRouter,
            value: intent.amount.amountAtomic,
            data: calldata.toLowerCase() as `0x${string}`,
          },
        ]
      : [
          {
            to: inputToken,
            value: '0',
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'approve',
              args: [builtRouter, BigInt(intent.amount.amountAtomic)],
            }),
          },
          { to: builtRouter, value: '0', data: calldata.toLowerCase() as `0x${string}` },
        ];

    const requestHash = canonicalRequestHash('kyberswap', { routesPath, buildBody });
    const responseHash = canonicalResponseHash('kyberswap', { routeSummary, routerAddress: builtRouter, calldata });
    return {
      outcome: 'built',
      provider: 'kyberswap',
      routerAddress: builtRouter,
      calls,
      quoteExpiry,
      requestId: input.requestId,
      requestHash,
      responseHash,
      expectedOutput,
      minimumOutput,
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}
