import { encodeFunctionData, erc20Abi } from 'viem';
import { canonicalUsdcForBaseChain } from '@mioagent/security/baseGuards';
import { readKyberSwapV1 } from '@mioagent/security/kyberRouterCalldata';
import { KYBERSWAP_CLIENT_ID_V1, loadSkillExecutor, type BaseMcpSkillExecutor } from '@mioagent/runtime-skills';
import {
  KYBERSWAP_BASE_ROUTER,
  atomicToHumanDecimal,
  canonicalRequestHash,
  canonicalResponseHash,
  normalizeAddress,
  parsePositiveAtomic,
  providerTokenAddress,
  routablePairV1,
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
import { routerMinimumFloorAtomicV1 } from './routerMinimum.js';


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
    // Any well-formed Base pair, both directions — the pair rule is stated
    // once, in swap-adapters, and shared with the quote path. The limit was
    // never KyberSwap's.
    if (intent.chainId !== 8453 || !routablePairV1(intent.fromAsset, intent.toAsset)) {
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
    // The routeSummary goes back exactly as KyberSwap sent it, or not at all.
    // Our own transport once rewrote a deep field to '[truncated]', and
    // route/build answered HTTP 500 with nothing to say why (2026-09-25).
    if (/"\[(?:truncated|redacted)\]"/.test(JSON.stringify(routeSummary))) {
      return failure('invalid_response', 'kyberswap_route_summary_altered', false);
    }

    // Build-side outputs come from the exact routeSummary that is POSTed to
    // route/build below — the same object the calldata is generated from.
    // The minimum is read from the built calldata below (audit SW-1).
    const summaryRecord = routeSummary as Record<string, unknown>;
    const buildAmountOut = parsePositiveAtomic(summaryRecord.amountOut);
    if (!buildAmountOut) return failure('invalid_response', 'kyberswap_routes_invalid', false);
    const buildExpectedDecimal = atomicToHumanDecimal(buildAmountOut, intent.toAsset!.decimals);
    if (buildExpectedDecimal === null) return failure('invalid_response', 'kyberswap_routes_invalid', false);
    const expectedOutput: TokenAmountV1 = {
      asset: intent.toAsset!,
      amountAtomic: buildAmountOut,
      amountDecimal: buildExpectedDecimal,
    };

    const deadline = Math.floor((input.now.getTime() + 10 * 60_000) / 1000);
    const quoteExpiry = new Date(deadline * 1000).toISOString();
    const buildBody = {
      routeSummary,
      sender: input.walletAddress,
      recipient: input.walletAddress,
      slippageTolerance: intent.slippageConstraint.maxBps,
      deadline,
      source: KYBERSWAP_CLIENT_ID_V1,
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
    // The minimum the review states is the one the router enforces, read from the built call (audit SW-1,
    // 2026-11-14): it was worked out from the routes quote, which says nothing about what the wallet signs.
    // A call Still cannot read, or one whose minimum is below the slippage the person allowed, is not offered.
    const reading = readKyberSwapV1(calldata, {
      wallet: input.walletAddress,
      inputToken: inputIsNative ? null : tokenIn,
      outputToken: intent.toAsset!.kind === 'native' ? null : tokenOut,
      amountInAtomic: BigInt(intent.amount.amountAtomic),
    });
    if (!reading.ok) return failure('rejected', reading.code, false);
    if (reading.minReturnAtomic > BigInt(buildAmountOut) ||
        reading.minReturnAtomic < routerMinimumFloorAtomicV1(buildAmountOut, intent.slippageConstraint.maxBps)) {
      return failure('rejected', 'kyberswap_minimum_outside_slippage', false);
    }
    const minimumDecimal = atomicToHumanDecimal(reading.minReturnAtomic.toString(), intent.toAsset!.decimals);
    if (minimumDecimal === null) return failure('invalid_response', 'kyberswap_build_invalid', false);
    const minimumOutput: TokenAmountV1 = { asset: intent.toAsset!, amountAtomic: reading.minReturnAtomic.toString(), amountDecimal: minimumDecimal };

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
