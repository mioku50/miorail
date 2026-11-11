import { decodeFunctionData, encodeFunctionData, erc20Abi, keccak256, parseTransaction, type Hex } from 'viem';
import type { AssetRefV1, LiquiditySourceRefV1, PoolRefV1 } from '@mioagent/route-domain';
import { O1OrderResponseV1Schema, type O1OrderRequestV1 } from './o1-client.js';
import {
  O1_ZEROX_ALLOWANCE_HOLDER_V1,
  O1_ZEROX_EXEC_ABI_V1,
  O1_ZEROX_EXEC_SELECTOR_V1,
  o1AttributionSuffixOrNothingV1,
  readO1SettlerSlippageV1,
} from './o1-pinned.js';
import { normalizeAddress } from './normalization.js';

export interface ParsedO1OrderV1 {
  orderId: string;
  swapTransactionId: string;
  routerAddress: typeof O1_ZEROX_ALLOWANCE_HOLDER_V1;
  /** The 0x Settler the order runs, which the registry named. */
  settler: `0x${string}`;
  swapCall: { to: `0x${string}`; value: string; data: Hex };
  providerApprovalCount: number;
  gasUnits: string;
  maxFeePerGasWei: string | null;
  amountInAtomic: string;
  minimumOutputAtomic: string;
  expectedOutputAtomic: string;
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

/**
 * Parses the raw unsigned transactions returned by o1. Nothing from
 * description/exchange labels grants permission. Targets, selectors, the
 * allowance and the Settler's final check all come from decoded RLP/calldata,
 * and the Settler must be one 0x's registry named when it was asked.
 */
export function parseO1OrderV1(input: {
  payload: unknown;
  request: O1OrderRequestV1;
  inputAsset: AssetRefV1;
  outputAsset: AssetRefV1;
  amountInAtomic: string;
  /** From the pin reader: the Settlers 0x's registry names now. */
  settlers: readonly string[];
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
  const signer = input.request.signerAddress.toLowerCase();
  if (!inputAddress || !outputAddress || !/^[1-9][0-9]*$/.test(input.amountInAtomic)) {
    return { ok: false, errorCode: 'o1_order_asset_unsupported' };
  }
  const expectedAmountIn = BigInt(input.amountInAtomic);
  const settlers = new Set(input.settlers.map((address) => address.toLowerCase()));

  let swap: {
    transactionId: string;
    to: `0x${string}`;
    data: Hex;
    settler: `0x${string}`;
    inner: Hex;
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

    if (to === O1_ZEROX_ALLOWANCE_HOLDER_V1 && data.slice(0, 10) === O1_ZEROX_EXEC_SELECTOR_V1) {
      if (swap) return { ok: false, errorCode: 'o1_swap_call_count_invalid' };
      let decoded: ReturnType<typeof decodeFunctionData<typeof O1_ZEROX_EXEC_ABI_V1>>;
      try {
        decoded = decodeFunctionData({ abi: O1_ZEROX_EXEC_ABI_V1, data });
      } catch {
        return { ok: false, errorCode: 'o1_swap_calldata_invalid' };
      }
      const [rawOperator, rawToken, amount, rawTarget, rawInner] = decoded.args;
      const operator = rawOperator.toLowerCase() as `0x${string}`;
      const inner = rawInner.toLowerCase() as Hex;
      // The registry decides which contract may be handed the allowance. An
      // address the order names and the registry does not is never run.
      if (!settlers.has(operator)) return { ok: false, errorCode: 'o1_settler_not_in_registry' };
      // The bytes are the five values read above, encoded the one standard
      // way, and behind them nothing but o1's own attribution suffix.
      const canonical = encodeFunctionData({ abi: O1_ZEROX_EXEC_ABI_V1, functionName: 'exec', args: decoded.args }).toLowerCase();
      if (
        rawTarget.toLowerCase() !== operator ||
        rawToken.toLowerCase() !== inputAddress ||
        amount !== expectedAmountIn ||
        value !== 0n ||
        !data.startsWith(canonical) ||
        !o1AttributionSuffixOrNothingV1(data.slice(canonical.length))
      ) {
        return { ok: false, errorCode: 'o1_swap_calldata_invalid' };
      }
      const slippage = readO1SettlerSlippageV1(inner);
      if (!slippage) return { ok: false, errorCode: 'o1_settler_call_invalid' };
      if (slippage.recipient !== signer || slippage.buyToken !== outputAddress) {
        return { ok: false, errorCode: 'o1_route_asset_mismatch' };
      }
      if (slippage.minAmountOut <= 0n) return { ok: false, errorCode: 'o1_minimum_output_invalid' };
      swap = {
        transactionId: entry.id,
        to: to as `0x${string}`,
        data,
        settler: operator,
        inner,
        minimumOut: slippage.minAmountOut,
      };
      continue;
    }

    if (to === inputAddress && data.slice(0, 10) === '0x095ea7b3') {
      try {
        const decoded = decodeFunctionData({ abi: erc20Abi, data });
        if (decoded.functionName !== 'approve') throw new TypeError('not approve');
        const [spender, amount] = decoded.args;
        if (
          spender.toLowerCase() !== O1_ZEROX_ALLOWANCE_HOLDER_V1 ||
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
  // The Settler's actions are not decoded, so no pool is named. The one
  // source says where the order settles; a build compares it with the quote's.
  const liquiditySources: LiquiditySourceRefV1[] = [
    {
      sourceKey: `eip155:8453/o1-exchange:zerox:${swap.settler}`,
      chainId: 8453,
      protocol: 'o1-exchange',
      poolAddress: null,
      assets: [input.inputAsset, input.outputAsset],
      upstreamProvider: 'zerox',
    },
  ];
  return {
    ok: true,
    value: {
      orderId: response.id,
      swapTransactionId: swap.transactionId,
      routerAddress: O1_ZEROX_ALLOWANCE_HOLDER_V1,
      settler: swap.settler,
      swapCall: { to: swap.to, value: '0', data: swap.data },
      providerApprovalCount: approvals,
      gasUnits: totalGas.toString(),
      maxFeePerGasWei: maxFeePerGas > 0n ? maxFeePerGas.toString() : null,
      amountInAtomic: expectedAmountIn.toString(),
      minimumOutputAtomic: swap.minimumOut.toString(),
      expectedOutputAtomic: expectedOutput.toString(),
      pools: [],
      liquiditySources,
      safeResponse: {
        orderId: response.id,
        transactionIds: response.transactions.map((entry) => entry.id),
        routerAddress: O1_ZEROX_ALLOWANCE_HOLDER_V1,
        settler: swap.settler,
        amountIn: expectedAmountIn.toString(),
        minimumOutput: swap.minimumOut.toString(),
        gasUnits: totalGas.toString(),
        settlerCallHash: keccak256(swap.inner),
        providerApprovalCount: approvals,
      },
    },
  };
}
