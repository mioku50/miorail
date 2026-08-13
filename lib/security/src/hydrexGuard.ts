import { decodeFunctionData, erc20Abi, type Hex } from 'viem';
import { normalizeBaseChain, type BaseCall } from './baseGuards.js';

/** Duplicated independently from swap-adapters to avoid a reverse dependency. */
export const HYDREX_BASE_ROUTER_PROXY = '0x599bfa1039c9e22603f15642b711d56be62071f4';
export const HYDREX_ZEROX_ALLOWANCE_HOLDER = '0x0000000000001ff3684f28c67538d4d072c22734';
export const HYDREX_KYBER_META_ROUTER = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5';
const HYDREX_ZEROX_INNER_SELECTOR = '0x2213bc0b';
const HYDREX_KYBER_INNER_SELECTOR = '0xe21fd0e9';

const HYDREX_EXECUTE_SWAPS_ABI = [
  {
    type: 'function', name: 'executeSwaps', stateMutability: 'payable',
    inputs: [
      { name: 'swaps', type: 'tuple[]', components: [
        { name: 'router', type: 'address' }, { name: 'inputAsset', type: 'address' },
        { name: 'outputAsset', type: 'address' }, { name: 'inputAmount', type: 'uint256' },
        { name: 'minOutputAmount', type: 'uint256' }, { name: 'callData', type: 'bytes' },
        { name: 'recipient', type: 'address' }, { name: 'origin', type: 'string' },
        { name: 'referral', type: 'address' }, { name: 'referralFeeBps', type: 'uint256' },
      ] },
      { name: 'deadline', type: 'uint256' },
    ], outputs: [],
  },
] as const;

const ADDRESS = /^0x[0-9a-f]{40}$/;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const UPSTREAMS = new Set([HYDREX_ZEROX_ALLOWANCE_HOLDER, HYDREX_KYBER_META_ROUTER]);

export interface HydrexSwapContext {
  inputTokenAddress: string;
  outputTokenAddress: string;
  amountInAtomic: string;
  minimumOutputAtomic: string;
  recipient: string;
  routerAddress: string;
  upstreamRouter: string;
  expiresAt: string;
}

export type HydrexGuardResult =
  | { success: true; code: 'allowed'; checks: string[]; semantics: {
      actionType: 'hydrex_swap'; tokenAddresses: string[]; recipients: string[];
      spenders: string[]; spendAmountRaw: string; minimumOutputRaw: string;
    } }
  | { success: false; code: string; reason: string; checks: string[] };

function fail(code: string, reason: string, checks: string[]): HydrexGuardResult {
  return { success: false, code, reason, checks };
}

function atomic(value: string): bigint | null {
  return /^(0|[1-9][0-9]*)$/.test(value) ? BigInt(value) : null;
}

export function validateHydrexSwap(input: {
  chain: string | number;
  calls: BaseCall[];
  context?: HydrexSwapContext;
  now?: Date;
}): HydrexGuardResult {
  const checks: string[] = [];
  let chain;
  try { chain = normalizeBaseChain(input.chain); }
  catch { return fail('hydrex_wrong_chain', 'Hydrex swap must target Base mainnet', checks); }
  if (chain.chainId !== 8453) return fail('hydrex_wrong_chain', 'Hydrex swap must target Base mainnet', checks);
  checks.push('Base mainnet chain');

  const context = input.context;
  if (!context) return fail('hydrex_context_missing', 'Hydrex context is required', checks);
  const router = context.routerAddress.toLowerCase();
  const upstream = context.upstreamRouter.toLowerCase();
  const inputToken = context.inputTokenAddress.toLowerCase();
  const outputToken = context.outputTokenAddress.toLowerCase();
  const recipient = context.recipient.toLowerCase();
  if (
    router !== HYDREX_BASE_ROUTER_PROXY || !UPSTREAMS.has(upstream) ||
    !ADDRESS.test(inputToken) || !ADDRESS.test(outputToken) || inputToken === outputToken ||
    !ADDRESS.test(recipient)
  ) return fail('hydrex_context_invalid', 'Hydrex assets, routers, or recipient are invalid', checks);
  const amountIn = atomic(context.amountInAtomic);
  const reviewedMinimum = atomic(context.minimumOutputAtomic);
  if (!amountIn || !reviewedMinimum || amountIn <= 0n || reviewedMinimum <= 0n) {
    return fail('hydrex_amount_invalid', 'Hydrex amounts are invalid', checks);
  }
  const expiry = Date.parse(context.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= (input.now ?? new Date()).getTime()) {
    return fail('hydrex_quote_expired', 'Prepared Hydrex route expired', checks);
  }
  if (!Array.isArray(input.calls) || input.calls.length !== 2) {
    return fail('hydrex_batch_size_invalid', 'Hydrex requires one exact approval and one swap', checks);
  }
  const [approvalCall, swapCall] = input.calls;
  let approvalValue: bigint;
  let swapValue: bigint;
  try {
    approvalValue = BigInt(String(approvalCall!.value ?? '0'));
    swapValue = BigInt(String(swapCall!.value ?? '0'));
  } catch {
    return fail('hydrex_value_invalid', 'Hydrex call value is invalid', checks);
  }
  if (String(approvalCall!.to).toLowerCase() !== inputToken || approvalValue !== 0n) {
    return fail('hydrex_approval_target_invalid', 'Hydrex approval must target only the input token', checks);
  }
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data: String(approvalCall!.data).toLowerCase() as Hex });
    if (decoded.functionName !== 'approve') throw new TypeError('not approve');
    if (decoded.args[0].toLowerCase() !== router || decoded.args[1] !== amountIn) {
      return fail('hydrex_approval_not_exact', 'Hydrex approval must be exact and proxy-bound', checks);
    }
  } catch {
    return fail('hydrex_approval_invalid', 'Hydrex approval calldata is invalid', checks);
  }
  checks.push('Exact input-token approval to pinned Hydrex proxy');
  if (String(swapCall!.to).toLowerCase() !== router || swapValue !== 0n) {
    return fail('hydrex_swap_target_invalid', 'Hydrex swap must target only the pinned proxy', checks);
  }
  let decodedSwap: ReturnType<typeof decodeFunctionData<typeof HYDREX_EXECUTE_SWAPS_ABI>>;
  try {
    decodedSwap = decodeFunctionData({ abi: HYDREX_EXECUTE_SWAPS_ABI, data: String(swapCall!.data).toLowerCase() as Hex });
  } catch {
    return fail('hydrex_swap_calldata_invalid', 'Hydrex swap calldata is invalid', checks);
  }
  if (decodedSwap.functionName !== 'executeSwaps' || decodedSwap.args[0].length !== 1) {
    return fail('hydrex_swap_calldata_invalid', 'Hydrex must contain exactly one swap tuple', checks);
  }
  const swap = decodedSwap.args[0][0]!;
  const deadline = decodedSwap.args[1];
  const expectedInnerSelector = upstream === HYDREX_ZEROX_ALLOWANCE_HOLDER
    ? HYDREX_ZEROX_INNER_SELECTOR
    : HYDREX_KYBER_INNER_SELECTOR;
  if (
    swap.router.toLowerCase() !== upstream ||
    swap.inputAsset.toLowerCase() !== inputToken ||
    swap.outputAsset.toLowerCase() !== outputToken ||
    swap.inputAmount !== amountIn ||
    swap.minOutputAmount < reviewedMinimum ||
    swap.recipient.toLowerCase() !== recipient ||
    swap.origin.toLowerCase() !== 'hydrex' ||
    swap.referral.toLowerCase() !== ZERO_ADDRESS ||
    swap.referralFeeBps !== 0n ||
    swap.callData.length < 10 ||
    swap.callData.slice(0, 10).toLowerCase() !== expectedInnerSelector ||
    deadline * 1000n !== BigInt(expiry)
  ) return fail('hydrex_swap_bounds_invalid', 'Hydrex route semantics do not match the review', checks);
  checks.push('Decoded exact input, reviewed minimum, recipient, deadline, and pinned upstream');
  return {
    success: true,
    code: 'allowed',
    checks,
    semantics: {
      actionType: 'hydrex_swap', tokenAddresses: [inputToken, outputToken], recipients: [recipient],
      spenders: [router], spendAmountRaw: amountIn.toString(), minimumOutputRaw: swap.minOutputAmount.toString(),
    },
  };
}
