import { decodeFunctionData, encodeFunctionData, type Hex } from 'viem';
import { sameCanonicalCallV1 } from './routerCalldataTail.js';

// ---------------------------------------------------------------------------
// What the bytes of a KyberSwap MetaAggregationRouterV2 call do (audit SW-1,
// 2026-11-14).
//
// The call to the pinned router was accepted by its address alone, and the
// "sender equals recipient" check compared two values Still wrote itself. The
// router draws `desc.srcToken` from the caller, so a route naming another token
// the wallet has approved to the router, a receiver other than the wallet, a
// fee receiver, or a minimum of nothing all passed.
//
// The router's own rules, read from its Sourcify-verified source (0x6131…37b5,
// full match, 2026-11-14): it pays `desc.dstReceiver` (the caller when zero),
// measures that receiver's balance, and refuses less than `minReturnAmount`,
// unless _PARTIAL_FILL scales the minimum to what was spent. It draws at most
// `desc.amount` of `desc.srcToken` from the caller, takes `feeAmounts` for
// `feeReceivers` out of it, and runs a `permit` it is handed. The executor's
// data is not read here: whatever it does, the receiver must end up with the
// minimum, and only the reviewed input can be drawn.
// ---------------------------------------------------------------------------

/** How the router names native ETH. */
export const KYBERSWAP_NATIVE_TOKEN_V1 = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const PARTIAL_FILL_V1 = 0x01n;
const REQUIRES_EXTRA_ETH_V1 = 0x02n;

const DESCRIPTION_V1 = {
  name: 'desc',
  type: 'tuple',
  components: [
    { name: 'srcToken', type: 'address' },
    { name: 'dstToken', type: 'address' },
    { name: 'srcReceivers', type: 'address[]' },
    { name: 'srcAmounts', type: 'uint256[]' },
    { name: 'feeReceivers', type: 'address[]' },
    { name: 'feeAmounts', type: 'uint256[]' },
    { name: 'dstReceiver', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'minReturnAmount', type: 'uint256' },
    { name: 'flags', type: 'uint256' },
    { name: 'permit', type: 'bytes' },
  ],
} as const;

export const KYBERSWAP_ROUTER_ABI_V1 = [
  {
    type: 'function',
    name: 'swap',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'execution',
        type: 'tuple',
        components: [
          { name: 'callTarget', type: 'address' },
          { name: 'approveTarget', type: 'address' },
          { name: 'targetData', type: 'bytes' },
          DESCRIPTION_V1,
          { name: 'clientData', type: 'bytes' },
        ],
      },
    ],
    outputs: [{ name: 'returnAmount', type: 'uint256' }, { name: 'gasUsed', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'swapSimpleMode',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'caller', type: 'address' },
      DESCRIPTION_V1,
      { name: 'executorData', type: 'bytes' },
      { name: 'clientData', type: 'bytes' },
    ],
    outputs: [{ name: 'returnAmount', type: 'uint256' }, { name: 'gasUsed', type: 'uint256' }],
  },
] as const;

interface KyberDescriptionV1 {
  srcToken: string;
  dstToken: string;
  srcReceivers: readonly string[];
  srcAmounts: readonly bigint[];
  feeReceivers: readonly string[];
  feeAmounts: readonly bigint[];
  dstReceiver: string;
  amount: bigint;
  minReturnAmount: bigint;
  flags: bigint;
  permit: string;
}

export interface KyberRouterExpectationV1 {
  wallet: string;
  /** An ERC-20 address, or null for native ETH. */
  inputToken: string | null;
  outputToken: string | null;
  amountInAtomic: bigint;
}

export type KyberRouterReadingV1 =
  | { ok: true; function: 'swap' | 'swapSimpleMode'; minReturnAtomic: bigint; dstReceiver: string }
  | { ok: false; code: string; reason: string };

function refuse(code: string, reason: string): KyberRouterReadingV1 {
  return { ok: false, code, reason };
}

/** The router's description of a swap, read exactly, or null. */
function readDescriptionV1(data: string): { function: 'swap' | 'swapSimpleMode'; desc: KyberDescriptionV1; executorData: string } | null {
  try {
    const decoded = decodeFunctionData({ abi: KYBERSWAP_ROUTER_ABI_V1, data: data as Hex });
    const again = encodeFunctionData({ abi: KYBERSWAP_ROUTER_ABI_V1, functionName: decoded.functionName, args: decoded.args as never });
    if (!sameCanonicalCallV1(data, again)) return null;
    if (decoded.functionName === 'swap') {
      const [execution] = decoded.args as unknown as [{ targetData: string; desc: KyberDescriptionV1 }];
      return { function: 'swap', desc: execution.desc, executorData: execution.targetData };
    }
    const [, desc, executorData] = decoded.args as unknown as [string, KyberDescriptionV1, string];
    return { function: 'swapSimpleMode', desc, executorData };
  } catch {
    return null;
  }
}

/** Reads a KyberSwap router call against the swap that was reviewed. Refuses anything it cannot read exactly. */
export function readKyberSwapV1(data: string, expected: KyberRouterExpectationV1): KyberRouterReadingV1 {
  const read = readDescriptionV1(data);
  if (!read) return refuse('kyberswap_router_call_undecodable', 'The router call is not the pinned KyberSwap router’s swap, read exactly');
  const { desc } = read;
  const token = (value: string | null) => value === null ? KYBERSWAP_NATIVE_TOKEN_V1 : value.toLowerCase();
  if (desc.srcToken.toLowerCase() !== token(expected.inputToken)) {
    return refuse('kyberswap_pulls_another_token', `The router call draws ${desc.srcToken.toLowerCase()} from the wallet, not the reviewed input`);
  }
  if (desc.dstToken.toLowerCase() !== token(expected.outputToken)) {
    return refuse('kyberswap_pays_another_token', `The router call buys ${desc.dstToken.toLowerCase()}, not the reviewed output`);
  }
  if (desc.amount !== expected.amountInAtomic) {
    return refuse('kyberswap_input_amount_mismatch', 'The router call does not spend exactly the reviewed input');
  }
  if (desc.dstReceiver.toLowerCase() !== expected.wallet.toLowerCase()) {
    return refuse('kyberswap_pays_another_address', `The router call pays ${desc.dstReceiver.toLowerCase()}, which is not the wallet`);
  }
  // Still charges no fee, and asks for none: a fee receiver is someone else paid out of this swap.
  if (desc.feeReceivers.length > 0 || desc.feeAmounts.length > 0) {
    return refuse('kyberswap_fee_not_allowed', 'The router call pays a fee to someone other than the wallet');
  }
  if (desc.permit !== '0x') return refuse('kyberswap_permit_not_allowed', 'The router call carries a token permit Still did not ask for');
  if ((desc.flags & PARTIAL_FILL_V1) !== 0n) {
    return refuse('kyberswap_partial_fill_not_allowed', 'The router call may fill part of the swap, which lowers its guaranteed minimum');
  }
  if ((desc.flags & REQUIRES_EXTRA_ETH_V1) !== 0n) {
    return refuse('kyberswap_extra_eth_not_allowed', 'The router call asks for more ETH than the swap spends');
  }
  if (desc.srcReceivers.length !== desc.srcAmounts.length || desc.srcAmounts.reduce((sum, amount) => sum + amount, 0n) > desc.amount) {
    return refuse('kyberswap_source_split_invalid', 'The router call hands its executors more than the reviewed input');
  }
  if (read.executorData === '0x') return refuse('kyberswap_router_call_undecodable', 'The router call names no route to execute');
  if (desc.minReturnAmount <= 0n) return refuse('kyberswap_minimum_missing', 'The router call guarantees the wallet no output');
  return { ok: true, function: read.function, minReturnAtomic: desc.minReturnAmount, dstReceiver: desc.dstReceiver.toLowerCase() };
}

/** Who a router call pays: the review's recipient. Null when the call cannot be read. */
export function kyberSwapRecipientV1(data: string): string | null {
  return readDescriptionV1(data)?.desc.dstReceiver.toLowerCase() ?? null;
}

/** The router call for a description, encoded exactly as the router reads it: for tests. */
export function encodeKyberSwapV1(input: {
  callTarget?: string;
  targetData?: Hex;
  srcToken: string;
  dstToken: string;
  dstReceiver: string;
  amount: bigint;
  minReturnAmount: bigint;
  flags?: bigint;
  srcReceivers?: string[];
  srcAmounts?: bigint[];
  feeReceivers?: string[];
  feeAmounts?: bigint[];
  permit?: Hex;
  clientData?: Hex;
}): Hex {
  const executor = (input.callTarget ?? '0x8f10b468b06c6fd214b65f87778827f7d113f996') as Hex;
  return encodeFunctionData({ abi: KYBERSWAP_ROUTER_ABI_V1, functionName: 'swap', args: [{
    callTarget: executor,
    approveTarget: '0x0000000000000000000000000000000000000000',
    targetData: input.targetData ?? '0x1234',
    desc: {
      srcToken: input.srcToken as Hex,
      dstToken: input.dstToken as Hex,
      srcReceivers: (input.srcReceivers ?? [executor]) as Hex[],
      srcAmounts: input.srcAmounts ?? [input.amount],
      feeReceivers: (input.feeReceivers ?? []) as Hex[],
      feeAmounts: input.feeAmounts ?? [],
      dstReceiver: input.dstReceiver as Hex,
      amount: input.amount,
      minReturnAmount: input.minReturnAmount,
      flags: input.flags ?? 0x200n,
      permit: input.permit ?? '0x',
    },
    clientData: input.clientData ?? '0x',
  }] });
}
