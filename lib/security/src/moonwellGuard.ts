// T44b: strict Moonwell action validator for the unified execution guard.
// Moonwell supply/withdraw/borrow/repay batches are prepared SERVER-SIDE from
// api.moonwell.fi (streamMoonwellWriteRouting) and stored on the action
// record; this validator re-checks that stored payload at /prepare time.
// Everything not provably matching the prepared shape fails closed. It never
// relaxes revoke_approval/limited_transfer validation — those keep their own
// unchanged path in executionGuard.

import type { BaseCall } from './baseGuards.js';
import { BASE_MAINNET_CHAIN_ID, canonicalUsdcForBaseChain, normalizeBaseChain } from './baseGuards.js';
import type { ExecutionSemantics } from './executionGuard.js';

export const MOONWELL_ACTION_TYPES = [
  'moonwell_supply',
  'moonwell_withdraw',
  'moonwell_borrow',
  'moonwell_repay',
] as const;

export type MoonwellActionType = typeof MOONWELL_ACTION_TYPES[number];

export function isMoonwellActionType(value?: string | null): value is MoonwellActionType {
  return (MOONWELL_ACTION_TYPES as readonly string[]).includes(String(value || ''));
}

export interface MoonwellActionCall extends BaseCall {
  /** Optional per-step chain id as returned by the Moonwell prepare API. */
  chainId?: number;
}

export interface MoonwellValidationInput {
  chain: string | number;
  actionType: MoonwellActionType;
  /** Server-stored calls from the action record's execution payload. */
  calls: MoonwellActionCall[];
  /** Server-stored prepared amount (human-readable USDC string). */
  amountDecimal?: string;
}

export interface MoonwellValidationResult {
  success: boolean;
  code: string;
  reason?: string;
  checks: string[];
  semantics?: ExecutionSemantics;
}

const APPROVE_SELECTOR = '0x095ea7b3';
const TRANSFER_SELECTOR = '0xa9059cbb';
// Compound v2 comptroller enterMarkets(address[]) — the only non-approve
// preparatory step the Moonwell prepare API emits before the verb step.
const ENTER_MARKETS_SELECTOR = '0xc2998238';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_PADDING = '0'.repeat(24);
const MAX_MOONWELL_STEPS = 4;
const USDC_DECIMALS = 6;

function fail(code: string, reason: string, checks: string[]): MoonwellValidationResult {
  return { success: false, code, reason, checks: [...checks, `Moonwell batch validation: Failed (${code})`] };
}

// Mirrors the strict ERC-20 decoder used by limited_transfer in
// executionGuard (exact 138-char calldata, zero-padded address word).
function decodeErc20Call(data?: string): { selector: string; account: string; amount: bigint } | null {
  const normalized = data?.toLowerCase();
  if (!normalized || !/^0x[0-9a-f]+$/.test(normalized) || normalized.length !== 138) return null;
  const selector = normalized.slice(0, 10);
  if (selector !== APPROVE_SELECTOR && selector !== TRANSFER_SELECTOR) return null;
  const accountWord = normalized.slice(10, 74);
  const amountWord = normalized.slice(74, 138);
  if (!accountWord.startsWith(ZERO_PADDING)) return null;
  try {
    return { selector, account: `0x${accountWord.slice(24)}`, amount: BigInt(`0x${amountWord}`) };
  } catch {
    return null;
  }
}

function parseValue(value?: string): bigint {
  if (!value) return 0n;
  try {
    return BigInt(value);
  } catch {
    return -1n;
  }
}

function toUsdcBaseUnits(amountDecimal: string): bigint | null {
  if (!/^\d+(?:\.\d+)?$/.test(amountDecimal)) return null;
  const [whole, fraction = ''] = amountDecimal.split('.');
  if (fraction.length > USDC_DECIMALS) return null;
  try {
    const units = BigInt(`${whole}${fraction.padEnd(USDC_DECIMALS, '0')}`);
    return units > 0n ? units : null;
  } catch {
    return null;
  }
}

type StepKind = 'approve' | 'enter-market' | 'verb';

function classifyStep(call: MoonwellActionCall): StepKind {
  const data = call.data?.toLowerCase() || '';
  if (data.startsWith(APPROVE_SELECTOR)) return 'approve';
  if (data.startsWith(ENTER_MARKETS_SELECTOR)) return 'enter-market';
  return 'verb';
}

/**
 * Validates a server-prepared Moonwell batch. All conditions are mandatory;
 * any deviation fails closed:
 * - actionType is one of the four Moonwell verbs; chain is Base mainnet
 *   (8453) and every step's chainId (when present) is 8453;
 * - 1..4 steps; EXACTLY one protocol verb step and it is the FINAL step;
 *   preceding steps may only be canonical-USDC approve or enterMarkets;
 * - value == 0 on every step (USDC-only flow; native-ETH branches rejected);
 * - the final verb step is never raw ERC-20 transfer/approve calldata;
 * - every approve step: token == canonical Base USDC, spender == `to` of a
 *   LATER step in the same batch, amount == the prepared action amount.
 */
export function validateMoonwellAction(input: MoonwellValidationInput): MoonwellValidationResult {
  const checks: string[] = [];

  if (!isMoonwellActionType(input.actionType)) {
    return fail('moonwell_action_type_invalid', 'Action type is not a Moonwell verb', checks);
  }
  checks.push('Moonwell action type: Passed');

  let chainId: number;
  try {
    chainId = normalizeBaseChain(input.chain).chainId;
  } catch (error) {
    return fail('unsupported_chain', error instanceof Error ? error.message : String(error), checks);
  }
  if (chainId !== BASE_MAINNET_CHAIN_ID) {
    return fail('moonwell_mainnet_only', 'Moonwell execution is limited to Base mainnet (8453)', checks);
  }
  checks.push('Chain validation (Base mainnet): Passed');

  const calls = Array.isArray(input.calls) ? input.calls : [];
  if (calls.length === 0 || calls.length > MAX_MOONWELL_STEPS) {
    return fail('moonwell_step_count_invalid', `Moonwell batches must contain 1..${MAX_MOONWELL_STEPS} steps`, checks);
  }
  checks.push('Step count (1..4): Passed');

  const canonicalUsdc = canonicalUsdcForBaseChain(chainId).toLowerCase();
  const amountRaw = toUsdcBaseUnits(String(input.amountDecimal ?? ''));
  if (amountRaw === null) {
    return fail('moonwell_amount_invalid', 'A positive prepared USDC amount is required', checks);
  }
  checks.push('Prepared amount: Passed');

  for (const [index, call] of calls.entries()) {
    if (!call?.to || !/^0x[a-fA-F0-9]{40}$/.test(call.to)) {
      return fail('moonwell_invalid_step_target', `Step ${index + 1} has no valid target address`, checks);
    }
    if (parseValue(call.value) !== 0n) {
      return fail('moonwell_native_value_blocked', 'Moonwell execution supports USDC only; native value transfers are rejected', checks);
    }
    if (call.chainId !== undefined && call.chainId !== BASE_MAINNET_CHAIN_ID) {
      return fail('moonwell_step_wrong_chain', `Step ${index + 1} targets a chain other than Base mainnet`, checks);
    }
  }
  checks.push('Step values (zero native value): Passed');

  const kinds = calls.map(classifyStep);
  const verbIndexes = kinds.flatMap((kind, index) => (kind === 'verb' ? [index] : []));
  if (verbIndexes.length !== 1 || verbIndexes[0] !== calls.length - 1) {
    return fail(
      'moonwell_batch_shape_invalid',
      'A Moonwell batch must end with exactly one protocol step preceded only by approve/enter-market steps',
      checks,
    );
  }
  const finalStep = calls[calls.length - 1];
  const finalDecoded = decodeErc20Call(finalStep.data);
  if (finalDecoded) {
    return fail('moonwell_final_step_erc20', 'The final Moonwell step must be a protocol call, not raw ERC-20 transfer/approve calldata', checks);
  }
  checks.push('Batch shape (approve/enter-market → verb): Passed');

  const spenders: string[] = [];
  for (const [index, call] of calls.entries()) {
    if (kinds[index] !== 'approve') continue;
    const decoded = decodeErc20Call(call.data);
    if (!decoded || decoded.selector !== APPROVE_SELECTOR) {
      return fail('moonwell_approve_malformed', `Approve step ${index + 1} calldata is malformed`, checks);
    }
    if (call.to.toLowerCase() !== canonicalUsdc) {
      return fail('moonwell_approve_noncanonical_token', 'Approve steps may only target canonical Base USDC', checks);
    }
    if (decoded.account === ZERO_ADDRESS) {
      return fail('moonwell_approve_zero_spender', 'Approve spender cannot be the zero address', checks);
    }
    const laterTargets = calls.slice(index + 1).map((later) => later.to.toLowerCase());
    if (!laterTargets.includes(decoded.account.toLowerCase())) {
      return fail('moonwell_approve_spender_outside_batch', 'Approve spender must be the target of a later step in the same batch', checks);
    }
    if (decoded.amount !== amountRaw) {
      return fail('moonwell_approve_amount_mismatch', 'Approve amount must equal the prepared action amount exactly', checks);
    }
    spenders.push(decoded.account);
  }
  checks.push('Approve steps (canonical USDC, in-batch spender, exact amount): Passed');

  return {
    success: true,
    code: 'allowed',
    checks: [...checks, 'Moonwell batch validation: Passed'],
    semantics: {
      actionType: input.actionType,
      tokenAddresses: [canonicalUsdc],
      recipients: [],
      spenders,
      spendAmountRaw: amountRaw.toString(),
      spendAmountUsdc: Number(amountRaw) / 10 ** USDC_DECIMALS,
    },
  };
}
