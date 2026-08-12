import { decodeFunctionData, erc20Abi, parseTransaction, type Hex } from 'viem';
import type { AssetRefV1, LiquiditySourceRefV1, PoolRefV1 } from '@mioagent/route-domain';
import { O1OrderResponseV1Schema, type O1OrderRequestV1 } from './o1-client.js';
import {
  O1_BASE_ROUTER_PROXY_V1,
  O1_MAX_HOPS_V1,
  O1_SWAP_ABI_V1,
  O1_SWAP_SELECTOR_V1,
} from './o1-pinned.js';
import { normalizeAddress } from './normalization.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface O1DecodedRouteLegV1 {
  dexType: number;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  pool: `0x${string}`;
  fee: number;
  tickSpacing: number;
  exchange: `0x${string}`;
  extraData: Hex;
}

export interface ParsedO1OrderV1 {
  orderId: string;
  swapTransactionId: string;
  routerAddress: typeof O1_BASE_ROUTER_PROXY_V1;
  swapCall: { to: `0x${string}`; value: string; data: Hex };
  providerApprovalCount: number;
  gasUnits: string;
  maxFeePerGasWei: string | null;
  amountInAtomic: string;
  minimumOutputAtomic: string;
  expectedOutputAtomic: string;
  route: O1DecodedRouteLegV1[];
  pools: PoolRefV1[];
  liquiditySources: LiquiditySourceRefV1[];
  safeResponse: Record<string, unknown>;
}

export type ParseO1OrderResultV1 =
  | { ok: true; value: ParsedO1OrderV1 }
  | { ok: false; errorCode: string };

function expectedFromMinimumV1(minimum: bigint, slippageBps: number): bigint | null {
  const denominator = 10_000n - BigInt(slippageBps);
  if (minimum <= 0n || denominator <= 0n) return null;
  return (minimum * 10_000n + denominator - 1n) / denominator;
}

function routeProtocolV1(leg: O1DecodedRouteLegV1): string {
  return `o1-dex-${leg.dexType}`;
}

function provenanceV1(
  route: O1DecodedRouteLegV1[],
  assets: readonly [AssetRefV1, AssetRefV1],
): { pools: PoolRefV1[]; liquiditySources: LiquiditySourceRefV1[] } {
  const pools = new Map<string, PoolRefV1>();
  const sources = new Map<string, LiquiditySourceRefV1>();
  for (const leg of route) {
    const protocol = routeProtocolV1(leg);
    const sourceKey = `eip155:8453/${protocol}:${leg.pool}`;
    pools.set(sourceKey, {
      chainId: 8453,
      address: leg.pool,
      protocol,
      // o1's tuple uses a venue-specific uint24 field. Calling it basis
      // points would invent units, so the normalized pool keeps it unknown.
      feeBps: null,
      assets: [...assets],
    });
    sources.set(sourceKey, {
      sourceKey,
      chainId: 8453,
      protocol,
      poolAddress: leg.pool,
      assets: [...assets],
      upstreamProvider: leg.exchange === ZERO_ADDRESS ? 'o1-exchange' : leg.exchange,
    });
  }
  return {
    pools: [...pools.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value),
    liquiditySources: [...sources.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, value]) => value),
  };
}

/**
 * Parses the raw unsigned transactions returned by o1. Nothing from
 * description/exchange labels grants permission. Targets, selectors, amounts
 * and route legs all come from decoded RLP/calldata.
 */
export function parseO1OrderV1(input: {
  payload: unknown;
  request: O1OrderRequestV1;
  inputAsset: AssetRefV1;
  outputAsset: AssetRefV1;
  amountInAtomic: string;
}): ParseO1OrderResultV1 {
  const parsed = O1OrderResponseV1Schema.safeParse(input.payload);
  if (!parsed.success) return { ok: false, errorCode: 'o1_order_invalid_schema' };
  const response = parsed.data;
  const echo = response.order;
  if (
    echo.networkId !== input.request.networkId ||
    normalizeAddress(echo.signerAddress) !== input.request.signerAddress.toLowerCase() ||
    normalizeAddress(echo.tokenAddress) !== input.request.tokenAddress.toLowerCase() ||
    normalizeAddress(echo.quoteTokenAddress) !== input.request.quoteTokenAddress.toLowerCase() ||
    echo.uiAmount !== input.request.uiAmount ||
    echo.direction !== input.request.direction ||
    echo.slippageBps !== input.request.slippageBps ||
    echo.mevProtection !== false
  ) {
    return { ok: false, errorCode: 'o1_order_echo_mismatch' };
  }

  const inputAddress = input.inputAsset.address?.toLowerCase();
  const outputAddress = input.outputAsset.address?.toLowerCase();
  if (!inputAddress || !outputAddress || !/^[1-9][0-9]*$/.test(input.amountInAtomic)) {
    return { ok: false, errorCode: 'o1_order_asset_unsupported' };
  }
  const expectedAmountIn = BigInt(input.amountInAtomic);

  let swap: {
    transactionId: string;
    to: `0x${string}`;
    value: bigint;
    data: Hex;
    route: O1DecodedRouteLegV1[];
    amountIn: bigint;
    minimumOut: bigint;
  } | null = null;
  let approvals = 0;
  let totalGas = 0n;
  let maxFeePerGas = 0n;

  for (const entry of response.transactions) {
    // Permit2 requires /order/complete, where o1 broadcasts through its relay.
    // That path is outside Miorail's non-custodial execution boundary.
    if (entry.permit2 !== undefined) {
      return { ok: false, errorCode: 'o1_permit2_relay_unsupported' };
    }
    let transaction: ReturnType<typeof parseTransaction>;
    try {
      transaction = parseTransaction(entry.unsigned as Hex);
    } catch {
      return { ok: false, errorCode: 'o1_unsigned_transaction_invalid' };
    }
    const to = transaction.to?.toLowerCase();
    const data = transaction.data?.toLowerCase() as Hex | undefined;
    const value = transaction.value ?? 0n;
    const gas = transaction.gas ?? 0n;
    const feePerGas = transaction.maxFeePerGas ?? transaction.gasPrice ?? null;
    if (transaction.chainId !== 8453 || !to || !data || !/^0x[0-9a-f]+$/.test(data) || gas <= 0n) {
      return { ok: false, errorCode: 'o1_unsigned_transaction_invalid' };
    }
    totalGas += gas;
    if (feePerGas !== null && feePerGas > maxFeePerGas) maxFeePerGas = feePerGas;

    if (to === O1_BASE_ROUTER_PROXY_V1 && data.slice(0, 10) === O1_SWAP_SELECTOR_V1) {
      if (swap) return { ok: false, errorCode: 'o1_swap_call_count_invalid' };
      let decoded: ReturnType<typeof decodeFunctionData<typeof O1_SWAP_ABI_V1>>;
      try {
        decoded = decodeFunctionData({ abi: O1_SWAP_ABI_V1, data });
      } catch {
        return { ok: false, errorCode: 'o1_swap_calldata_invalid' };
      }
      if (decoded.functionName !== 'swap') {
        return { ok: false, errorCode: 'o1_swap_calldata_invalid' };
      }
      const [rawRoute, rawSettlementToken, amountIn, minimumOut] = decoded.args;
      const settlementToken = rawSettlementToken.toLowerCase();
      if (
        rawRoute.length === 0 ||
        rawRoute.length > O1_MAX_HOPS_V1 ||
        (settlementToken !== inputAddress && settlementToken !== outputAddress) ||
        amountIn !== expectedAmountIn ||
        minimumOut <= 0n ||
        value !== 0n
      ) {
        return { ok: false, errorCode: 'o1_swap_calldata_invalid' };
      }
      const route: O1DecodedRouteLegV1[] = rawRoute.map((leg) => ({
        dexType: Number(leg.dexType),
        tokenIn: leg.tokenIn.toLowerCase() as `0x${string}`,
        tokenOut: leg.tokenOut.toLowerCase() as `0x${string}`,
        pool: leg.pool.toLowerCase() as `0x${string}`,
        fee: Number(leg.fee),
        tickSpacing: Number(leg.tickSpacing),
        exchange: leg.exchange.toLowerCase() as `0x${string}`,
        extraData: leg.extraData.toLowerCase() as Hex,
      }));
      if (
        route[0]!.tokenIn !== inputAddress ||
        route[route.length - 1]!.tokenOut !== outputAddress ||
        route.some(
          (leg, index) =>
            leg.pool === ZERO_ADDRESS || (index > 0 && leg.tokenIn !== route[index - 1]!.tokenOut),
        )
      ) {
        return { ok: false, errorCode: 'o1_route_asset_mismatch' };
      }
      swap = {
        transactionId: entry.id,
        to: to as `0x${string}`,
        value,
        data,
        route,
        amountIn,
        minimumOut,
      };
      continue;
    }

    if (to === inputAddress && data.slice(0, 10) === '0x095ea7b3') {
      try {
        const decoded = decodeFunctionData({ abi: erc20Abi, data });
        if (decoded.functionName !== 'approve') throw new TypeError('not approve');
        const [spender, amount] = decoded.args;
        if (
          spender.toLowerCase() !== O1_BASE_ROUTER_PROXY_V1 ||
          amount < expectedAmountIn ||
          value !== 0n
        ) {
          return { ok: false, errorCode: 'o1_provider_approval_invalid' };
        }
      } catch {
        return { ok: false, errorCode: 'o1_provider_approval_invalid' };
      }
      approvals += 1;
      if (approvals > 1) return { ok: false, errorCode: 'o1_provider_approval_invalid' };
      continue;
    }

    return { ok: false, errorCode: 'o1_transaction_target_not_allowlisted' };
  }

  if (!swap) return { ok: false, errorCode: 'o1_swap_call_count_invalid' };
  const expectedOutput = expectedFromMinimumV1(swap.minimumOut, input.request.slippageBps);
  if (!expectedOutput) return { ok: false, errorCode: 'o1_minimum_output_invalid' };
  const provenance = provenanceV1(swap.route, [input.inputAsset, input.outputAsset]);
  return {
    ok: true,
    value: {
      orderId: response.id,
      swapTransactionId: swap.transactionId,
      routerAddress: O1_BASE_ROUTER_PROXY_V1,
      swapCall: { to: swap.to, value: swap.value.toString(), data: swap.data },
      providerApprovalCount: approvals,
      gasUnits: totalGas.toString(),
      maxFeePerGasWei: maxFeePerGas > 0n ? maxFeePerGas.toString() : null,
      amountInAtomic: swap.amountIn.toString(),
      minimumOutputAtomic: swap.minimumOut.toString(),
      expectedOutputAtomic: expectedOutput.toString(),
      route: swap.route,
      pools: provenance.pools,
      liquiditySources: provenance.liquiditySources,
      safeResponse: {
        orderId: response.id,
        transactionIds: response.transactions.map((entry) => entry.id),
        routerAddress: O1_BASE_ROUTER_PROXY_V1,
        amountIn: swap.amountIn.toString(),
        minimumOutput: swap.minimumOut.toString(),
        gasUnits: totalGas.toString(),
        route: swap.route,
        providerApprovalCount: approvals,
      },
    },
  };
}
