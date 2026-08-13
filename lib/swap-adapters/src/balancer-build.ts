import {
  PERMIT2,
  Slippage,
  Swap,
  SwapKind,
  VAULT_V2,
  balancerV3Contracts,
  type Path,
} from '@balancer/sdk';
import { encodeFunctionData, erc20Abi } from 'viem';
import type { BalancerPathV1 } from './balancer-client.js';

export const BALANCER_V2_VAULT_BASE_V1 =
  VAULT_V2[8453]!.toLowerCase() as `0x${string}`;
export const BALANCER_PERMIT2_BASE_V1 =
  PERMIT2[8453]!.toLowerCase() as `0x${string}`;
export const BALANCER_V3_ROUTER_BASE_V1 =
  balancerV3Contracts.Router[8453]!.toLowerCase() as `0x${string}`;
export const BALANCER_V3_BATCH_ROUTER_BASE_V1 =
  balancerV3Contracts.BatchRouter[8453]!.toLowerCase() as `0x${string}`;

const permit2ApproveAbi = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
    ],
    outputs: [],
  },
] as const;

export interface BalancerBuiltCallV1 {
  to: `0x${string}`;
  value: string;
  data: `0x${string}`;
}

export interface BuildBalancerSwapV1Input {
  paths: readonly BalancerPathV1[];
  rpcUrl: string;
  walletAddress: `0x${string}`;
  inputToken: `0x${string}`;
  inputAmountAtomic: string;
  slippageBps: number;
  minimumFloorAtomic: string;
  now: Date;
}

export interface BuildBalancerSwapV1Output {
  protocolVersion: 2 | 3;
  routerAddress: `0x${string}`;
  expectedOutputAtomic: string;
  minimumOutputAtomic: string;
  quoteExpiry: string;
  calls: BalancerBuiltCallV1[];
}

export async function buildBalancerSwapV1(
  input: BuildBalancerSwapV1Input,
): Promise<BuildBalancerSwapV1Output> {
  if (!input.rpcUrl.trim()) throw new TypeError('Balancer build requires a Base RPC URL');
  const versions = new Set(input.paths.map((path) => path.protocolVersion));
  if (versions.size !== 1) throw new TypeError('Balancer paths cannot mix protocol versions');
  const protocolVersion = input.paths[0]?.protocolVersion;
  if (protocolVersion !== 2 && protocolVersion !== 3) throw new TypeError('Unsupported Balancer protocol');
  const paths: Path[] = input.paths.map((path) => ({
    protocolVersion: path.protocolVersion,
    pools: path.pools as `0x${string}`[],
    isBuffer: path.isBuffer,
    inputAmountRaw: BigInt(path.inputAmountRaw),
    outputAmountRaw: BigInt(path.outputAmountRaw),
    tokens: path.tokens.map((token) => ({
      address: token.address.toLowerCase() as `0x${string}`,
      decimals: token.decimals,
    })),
  }));
  const swap = new Swap({ chainId: 8453, paths, swapKind: SwapKind.GivenIn });
  const queryOutput = await swap.query(input.rpcUrl, undefined, input.walletAddress);
  if (queryOutput.swapKind !== SwapKind.GivenIn) throw new TypeError('Balancer query changed swap kind');
  const deadline = BigInt(Math.floor(input.now.getTime() / 1000) + 180);
  const expectedOut = queryOutput.expectedAmountOut.amount;
  const reviewedFloor = BigInt(input.minimumFloorAtomic);
  if (reviewedFloor <= 0n || reviewedFloor > expectedOut) {
    throw new TypeError('Balancer reviewed minimum exceeds the fresh onchain output');
  }
  const floorBps = Number(((expectedOut - reviewedFloor) * 10_000n) / expectedOut);
  const effectiveSlippageBps = Math.min(input.slippageBps, floorBps);
  const buildInput = {
    queryOutput,
    slippage: Slippage.fromBasisPoints(String(effectiveSlippageBps) as `${number}`),
    deadline,
    ...(protocolVersion === 2
      ? { sender: input.walletAddress, recipient: input.walletAddress }
      : {}),
  };
  const built = swap.buildCall(buildInput);
  if (!('minAmountOut' in built)) throw new TypeError('Balancer build did not return an exact-in minimum');
  if (built.minAmountOut.amount < reviewedFloor) {
    throw new TypeError('Balancer SDK minimum is below the reviewed floor');
  }
  const routerAddress = built.to.toLowerCase() as `0x${string}`;
  const allowedRouter =
    protocolVersion === 2
      ? routerAddress === BALANCER_V2_VAULT_BASE_V1
      : routerAddress === BALANCER_V3_ROUTER_BASE_V1 ||
        routerAddress === BALANCER_V3_BATCH_ROUTER_BASE_V1;
  if (!allowedRouter) throw new TypeError('Balancer SDK selected an unpinned router');

  const amountIn = BigInt(input.inputAmountAtomic);
  if (amountIn <= 0n || amountIn >= 2n ** 160n) throw new TypeError('Balancer input amount is outside Permit2 bounds');
  const calls: BalancerBuiltCallV1[] = [];
  if (protocolVersion === 2) {
    calls.push({
      to: input.inputToken,
      value: '0',
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [BALANCER_V2_VAULT_BASE_V1, amountIn],
      }),
    });
  } else {
    calls.push({
      to: input.inputToken,
      value: '0',
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [BALANCER_PERMIT2_BASE_V1, amountIn],
      }),
    });
    calls.push({
      to: BALANCER_PERMIT2_BASE_V1,
      value: '0',
      data: encodeFunctionData({
        abi: permit2ApproveAbi,
        functionName: 'approve',
        args: [input.inputToken, routerAddress, amountIn, Number(deadline)],
      }),
    });
  }
  calls.push({ to: routerAddress, value: built.value.toString(), data: built.callData });
  return {
    protocolVersion,
    routerAddress,
    expectedOutputAtomic: queryOutput.expectedAmountOut.amount.toString(),
    minimumOutputAtomic: built.minAmountOut.amount.toString(),
    quoteExpiry: new Date(input.now.getTime() + 30_000).toISOString(),
    calls,
  };
}
