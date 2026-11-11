import { decodeFunctionData, encodeFunctionData, erc20Abi, type Hex } from 'viem';
import { normalizeBaseChain, type BaseCall } from './baseGuards.js';

/** Duplicated independently from swap-adapters to prevent a reverse package
 * dependency. Cross-package tests assert these bytes stay equal.
 *
 * Since 2026-11-11 an o1 order is an `exec` on 0x's AllowanceHolder that runs
 * the Settler 0x's registry names; o1's own router is no longer accepted. */
export const O1_ZEROX_ALLOWANCE_HOLDER = '0x0000000000001ff3684f28c67538d4d072c22734';
export const O1_ZEROX_SETTLER_EXECUTE_SELECTOR = '0x1fff991f';

const O1_ZEROX_EXEC_ABI = [
  {
    type: 'function',
    name: 'exec',
    stateMutability: 'payable',
    inputs: [
      { name: 'operator', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'target', type: 'address' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [{ name: 'result', type: 'bytes' }],
  },
] as const;

const ADDRESS = /^0x[0-9a-f]{40}$/;
const ADDRESS_WORD = /^0{24}[0-9a-f]{40}$/;

/** Nothing, or exactly one ERC-8021 attribution suffix (schema 0): ASCII
 * codes, their length, a zero byte, the sixteen-byte marker. o1 ends its
 * orders with its Builder Code; AllowanceHolder reads nothing after its own
 * five arguments. Anything else behind them is unexplained and refused. */
function attributionSuffixOrNothing(tail: string): boolean {
  if (tail === '') return true;
  const match = /^((?:[0-9a-f]{2}){1,64})([0-9a-f]{2})00(?:8021){8}$/.exec(tail);
  if (!match) return false;
  const codes = match[1]!;
  if (parseInt(match[2]!, 16) !== codes.length / 2) return false;
  return (codes.match(/.{2}/g) ?? []).every((byte) => {
    const value = parseInt(byte, 16);
    return value >= 0x21 && value <= 0x7e;
  });
}

export interface O1SwapContext {
  inputTokenAddress: string;
  outputTokenAddress: string;
  amountInAtomic: string;
  minimumOutputAtomic: string;
  swapper: string;
  routerAddress: string;
  /** The Settlers 0x's registry named when the batch was built. Read from the
   * chain by the build, never taken from the order. */
  settlers: readonly string[];
  expiresAt: string;
}

export type O1GuardResult =
  | {
      success: true;
      code: 'allowed';
      checks: string[];
      semantics: {
        actionType: 'o1_exchange_swap';
        tokenAddresses: string[];
        recipients: string[];
        spenders: string[];
        spendAmountRaw: string;
        minimumOutputRaw: string;
        settler: string;
      };
    }
  | { success: false; code: string; reason: string; checks: string[] };

function fail(code: string, reason: string, checks: string[]): O1GuardResult {
  return { success: false, code, reason, checks };
}

function atomic(value: string): bigint | null {
  return /^(0|[1-9][0-9]*)$/.test(value) ? BigInt(value) : null;
}

/** Strict decoder/guard for the exact two-call o1 standard swap batch. */
export function validateO1Swap(input: {
  chain: string | number;
  calls: BaseCall[];
  context?: O1SwapContext;
  now?: Date;
}): O1GuardResult {
  const checks: string[] = [];
  let chain;
  try {
    chain = normalizeBaseChain(input.chain);
  } catch {
    return fail('o1_wrong_chain', 'o1.exchange swap must target Base mainnet', checks);
  }
  if (chain.chainId !== 8453) {
    return fail('o1_wrong_chain', 'o1.exchange swap must target Base mainnet', checks);
  }
  checks.push('Base mainnet chain');

  const context = input.context;
  if (!context) return fail('o1_context_missing', 'o1.exchange context is required', checks);
  const router = context.routerAddress.toLowerCase();
  const inputToken = context.inputTokenAddress.toLowerCase();
  const outputToken = context.outputTokenAddress.toLowerCase();
  const swapper = context.swapper.toLowerCase();
  const settlers = Array.isArray(context.settlers) ? context.settlers.map((address) => String(address).toLowerCase()) : [];
  if (
    router !== O1_ZEROX_ALLOWANCE_HOLDER ||
    !ADDRESS.test(inputToken) ||
    !ADDRESS.test(outputToken) ||
    inputToken === outputToken ||
    !ADDRESS.test(swapper)
  ) {
    return fail('o1_context_invalid', 'o1.exchange assets, router, or wallet are invalid', checks);
  }
  if (settlers.length === 0 || settlers.length > 2 || settlers.some((address) => !ADDRESS.test(address))) {
    return fail('o1_settler_unverified', 'No 0x Settler was read from the registry for this batch', checks);
  }
  const amountIn = atomic(context.amountInAtomic);
  const reviewedMinimum = atomic(context.minimumOutputAtomic);
  if (!amountIn || !reviewedMinimum || amountIn <= 0n || reviewedMinimum <= 0n) {
    return fail('o1_amount_invalid', 'o1.exchange amounts are invalid', checks);
  }
  const expiry = Date.parse(context.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= (input.now ?? new Date()).getTime()) {
    return fail('o1_quote_expired', 'Prepared o1.exchange route expired', checks);
  }
  if (!Array.isArray(input.calls) || input.calls.length !== 2) {
    return fail(
      'o1_batch_size_invalid',
      'o1.exchange requires one exact approval and one swap',
      checks,
    );
  }

  const [approvalCall, swapCall] = input.calls;
  let approvalValue: bigint;
  let swapValue: bigint;
  try {
    approvalValue = BigInt(String(approvalCall!.value ?? '0'));
    swapValue = BigInt(String(swapCall!.value ?? '0'));
  } catch {
    return fail('o1_value_invalid', 'o1.exchange call value is invalid', checks);
  }
  if (String(approvalCall!.to).toLowerCase() !== inputToken || approvalValue !== 0n) {
    return fail(
      'o1_approval_target_invalid',
      'o1.exchange approval must target only the input token',
      checks,
    );
  }
  try {
    const decoded = decodeFunctionData({
      abi: erc20Abi,
      data: String(approvalCall!.data).toLowerCase() as Hex,
    });
    if (decoded.functionName !== 'approve') throw new TypeError('not approve');
    const [spender, amount] = decoded.args;
    if (spender.toLowerCase() !== router || amount !== amountIn) {
      return fail(
        'o1_approval_not_exact',
        'o1.exchange approval must be exact and bound to AllowanceHolder',
        checks,
      );
    }
  } catch {
    return fail('o1_approval_invalid', 'o1.exchange approval calldata is invalid', checks);
  }
  checks.push('Exact input-token approval to 0x AllowanceHolder');

  if (String(swapCall!.to).toLowerCase() !== router || swapValue !== 0n) {
    return fail(
      'o1_swap_target_invalid',
      'o1.exchange swap must target only 0x AllowanceHolder',
      checks,
    );
  }
  const swapData = String(swapCall!.data).toLowerCase() as Hex;
  let decodedSwap: ReturnType<typeof decodeFunctionData<typeof O1_ZEROX_EXEC_ABI>>;
  try {
    decodedSwap = decodeFunctionData({ abi: O1_ZEROX_EXEC_ABI, data: swapData });
  } catch {
    return fail('o1_swap_calldata_invalid', 'o1.exchange swap calldata is invalid', checks);
  }
  const [rawOperator, rawToken, allowance, rawTarget, rawInner] = decodedSwap.args;
  const operator = rawOperator.toLowerCase();
  if (!settlers.includes(operator)) {
    return fail(
      'o1_settler_not_in_registry',
      'The contract given the allowance is not a Settler the 0x registry named',
      checks,
    );
  }
  let canonical: string;
  try {
    canonical = encodeFunctionData({ abi: O1_ZEROX_EXEC_ABI, functionName: 'exec', args: decodedSwap.args }).toLowerCase();
  } catch {
    return fail('o1_swap_calldata_invalid', 'o1.exchange swap calldata is invalid', checks);
  }
  if (
    rawTarget.toLowerCase() !== operator ||
    rawToken.toLowerCase() !== inputToken ||
    allowance !== amountIn ||
    !swapData.startsWith(canonical) ||
    !attributionSuffixOrNothing(swapData.slice(canonical.length))
  ) {
    return fail(
      'o1_swap_bounds_invalid',
      'The allowance is not exactly the reviewed input, for the Settler alone',
      checks,
    );
  }
  checks.push('One-transaction allowance: exact input, input token, registry-named Settler');

  // The Settler reads its final check from the three words after the selector.
  const inner = rawInner.toLowerCase();
  const word = (index: number) => inner.slice(10 + index * 64, 10 + (index + 1) * 64);
  if (
    inner.length < 10 + 5 * 64 ||
    inner.slice(0, 10) !== O1_ZEROX_SETTLER_EXECUTE_SELECTOR ||
    !ADDRESS_WORD.test(word(0)) ||
    !ADDRESS_WORD.test(word(1))
  ) {
    return fail('o1_settler_call_invalid', 'The Settler call is not execute with a readable final check', checks);
  }
  const recipient = `0x${word(0).slice(24)}`;
  const buyToken = `0x${word(1).slice(24)}`;
  const minimumOut = BigInt(`0x${word(2)}`);
  if (recipient !== swapper || buyToken !== outputToken) {
    return fail(
      'o1_route_asset_mismatch',
      'The Settler would pay another address or another token',
      checks,
    );
  }
  if (minimumOut < reviewedMinimum) {
    return fail(
      'o1_swap_bounds_invalid',
      'The Settler would accept less than the reviewed minimum',
      checks,
    );
  }
  checks.push('Settler pays the wallet the reviewed token, at least the reviewed minimum');
  return {
    success: true,
    code: 'allowed',
    checks,
    semantics: {
      actionType: 'o1_exchange_swap',
      tokenAddresses: [inputToken, outputToken],
      // The Settler sends what it bought to slippage.recipient, checked above.
      recipients: [swapper],
      spenders: [router],
      spendAmountRaw: amountIn.toString(),
      minimumOutputRaw: minimumOut.toString(),
      settler: operator,
    },
  };
}
