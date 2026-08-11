import { screenAction, type ScreenResult } from './index.js';
import {
  BASE_MAINNET_CHAIN_ID,
  canonicalUsdcForBaseChain,
  normalizeBaseChain,
  validateBaseCalls,
  type BaseCall,
  type NormalizedBaseChain,
} from './baseGuards.js';
import { simulateTrade, type SimulationResult } from './simulation.js';
import { isMoonwellActionType, validateMoonwellAction, type MoonwellActionCall, type MoonwellActionType } from './moonwellGuard.js';
import { validateUniswapSwap, type UniswapSwapContext } from './uniswapGuard.js';

// T44b: moonwell_* verbs join the typed whitelist with their OWN strict
// validator (moonwellGuard). revoke_approval/limited_transfer semantics are
// untouched — they keep the exact path below.
export type ExecutableActionType = 'revoke_approval' | 'limited_transfer' | 'uniswap_swap' | MoonwellActionType;

/**
 * The specific things a token contract can do to its holder.
 *
 * These were read from GoPlus and then DROPPED on the way to the Safety
 * Kernel, which saw only the aggregated status. For the canonical three assets
 * that cost nothing. For any other token it is the whole question: "can this
 * be sold at all" and "what does selling cost" are the difference between a
 * token and a trap, and neither is visible in a one-word status.
 *
 * Structural on purpose — lib/security does not depend on lib/data-providers.
 */
export interface ExecutionTokenSecurityFlags {
  isHoneypot?: boolean;
  cannotSellAll?: boolean;
  ownerCanChangeBalance?: boolean;
  hiddenOwner?: boolean;
  canTakeBackOwnership?: boolean;
  selfdestruct?: boolean;
  hasBlacklist?: boolean;
  isMintable?: boolean;
  isProxy?: boolean;
  isOpenSource?: boolean;
  /** Percentages as the provider sends them: "0", "0.05", "40". */
  buyTax?: string;
  sellTax?: string;
}

export interface ExecutionTokenSecurityResult {
  address: string;
  provider: 'goplus' | 'none';
  status: 'ok' | 'warning' | 'high-risk' | 'unknown' | 'failed';
  summary?: string;
  rawRiskLabels?: string[];
  flags?: ExecutionTokenSecurityFlags;
}

export interface ExecutionGuardProviderContext {
  risk?: string;
  riskProvider?: string;
  securityProvider?: string;
}

export interface ExecutionSemantics {
  actionType: ExecutableActionType;
  tokenAddresses: string[];
  recipients: string[];
  spenders: string[];
  spendAmountRaw: string;
  spendAmountUsdc: number;
}

export interface ExecutionGuardInput {
  chain: string | number;
  actionType: ExecutableActionType;
  calls: BaseCall[];
  instruction: string;
  memoryMd?: string | null;
  providerContext?: ExecutionGuardProviderContext;
  tokenSecurity?: ExecutionTokenSecurityResult[];
  /**
   * T44b: server-stored Moonwell context (prepared amount) from the action
   * record created by streamMoonwellWriteRouting. Required for moonwell_*
   * action types; ignored for every other type.
   */
  moonwell?: { amountDecimal: string };
  /** Server-stored quote/batch context; never accepted from the client body. */
  uniswap?: UniswapSwapContext;
}

export interface ExecutionGuardResult {
  success: boolean;
  allowed: boolean;
  code: string;
  reason?: string;
  chain?: NormalizedBaseChain;
  screening?: ScreenResult;
  simulation?: SimulationResult;
  semantics?: ExecutionSemantics;
  contractSecurity: {
    required: boolean;
    status: 'passed' | 'warning' | 'blocked' | 'skipped';
    provider: string;
    checkedAddresses: string[];
    warnings: string[];
  };
}

const APPROVE_SELECTOR = '0x095ea7b3';
const TRANSFER_SELECTOR = '0xa9059cbb';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_PADDING = '0'.repeat(24);
const MAX_ATOMIC_CALLS = 10;
const USDC_DECIMALS = 1_000_000n;

export async function evaluateExecutableAction(input: ExecutionGuardInput): Promise<ExecutionGuardResult> {
  let chain: NormalizedBaseChain;
  try {
    chain = normalizeBaseChain(input.chain);
  } catch (error) {
    return blocked('unsupported_chain', error);
  }

  // T44b: Moonwell verbs use their own strict validator instead of the
  // canonical-USDC calldata path. Contract security (GoPlus on canonical USDC)
  // is REQUIRED for them on mainnet, same as limited_transfer.
  const requiresContractSecurity = chain.chainId === BASE_MAINNET_CHAIN_ID
    && (input.actionType === 'limited_transfer' || input.actionType === 'uniswap_swap' || isMoonwellActionType(input.actionType));
  const screening = screenAction({
    instruction: input.instruction,
    memoryMd: input.memoryMd,
    providerContext: {
      ...input.providerContext,
      requiresTokenSecurity: requiresContractSecurity,
    },
  });
  if (!screening.allowed) {
    return blocked('security_screening_blocked', screening.reason || 'Security screening blocked action', {
      chain,
      screening,
      contractSecurity: contractState(input, requiresContractSecurity, 'blocked'),
    });
  }

  if (isMoonwellActionType(input.actionType)) {
    const validated = validateMoonwellAction({
      chain: input.chain,
      actionType: input.actionType,
      calls: input.calls as MoonwellActionCall[],
      amountDecimal: input.moonwell?.amountDecimal,
    });
    const simulation: SimulationResult = validated.success
      ? {
          success: true,
          allowed: true,
          riskLevel: 'low',
          method: 'preflight-validation',
          reason: 'Moonwell ordered-batch preflight validation passed (no fork simulation)',
          estimatedGas: '21000',
          expectedOutput: 'Server-prepared Moonwell batch validated against the strict Moonwell guard',
          checks: validated.checks,
        }
      : {
          success: false,
          allowed: false,
          riskLevel: 'blocked',
          method: 'preflight-validation',
          reason: validated.reason,
          error: validated.reason,
          checks: validated.checks,
        };
    if (!validated.success || !validated.semantics) {
      return blocked(validated.code, validated.reason || 'Moonwell guard blocked action', {
        chain,
        screening,
        simulation,
        contractSecurity: contractState(input, requiresContractSecurity, 'blocked'),
      });
    }
    const moonwellContractSecurity = evaluateContractSecurity(
      input,
      validated.semantics.tokenAddresses,
      requiresContractSecurity,
    );
    if (moonwellContractSecurity.status === 'blocked') {
      return blocked('contract_security_blocked', moonwellContractSecurity.warnings.join('; ') || 'Contract security gate blocked action', {
        chain,
        screening,
        simulation,
        semantics: validated.semantics,
        contractSecurity: moonwellContractSecurity,
      });
    }
    return {
      success: true,
      allowed: true,
      code: 'allowed',
      chain,
      screening,
      simulation,
      semantics: validated.semantics,
      contractSecurity: moonwellContractSecurity,
    };
  }

  if (input.actionType === 'uniswap_swap') {
    const validated = validateUniswapSwap({ chain: input.chain, calls: input.calls, context: input.uniswap });
    const simulation: SimulationResult = validated.success
      ? {
          success: true,
          allowed: true,
          riskLevel: 'medium',
          method: 'preflight-validation',
          reason: 'Uniswap 5792 batch passed pinned-router and exact-approval validation',
          estimatedGas: 'unknown',
          expectedOutput: 'Wallet-confirmed Uniswap swap prepared by the official API',
          checks: validated.checks,
        }
      : {
          success: false,
          allowed: false,
          riskLevel: 'blocked',
          method: 'preflight-validation',
          reason: validated.reason,
          error: validated.reason,
          checks: validated.checks,
        };
    if (!validated.success) {
      return blocked(validated.code, validated.reason, {
        chain,
        screening,
        simulation,
        contractSecurity: contractState(input, true, 'blocked'),
      });
    }
    const contractSecurity = evaluateContractSecurity(input, validated.semantics.tokenAddresses, true);
    if (contractSecurity.status === 'blocked') {
      return blocked('contract_security_blocked', contractSecurity.warnings.join('; ') || 'Contract security gate blocked action', {
        chain,
        screening,
        simulation,
        semantics: validated.semantics,
        contractSecurity,
      });
    }
    return {
      success: true,
      allowed: true,
      code: 'allowed',
      chain,
      screening,
      simulation,
      semantics: validated.semantics,
      contractSecurity,
    };
  }

  if (input.calls.length > MAX_ATOMIC_CALLS) {
    return blocked('batch_too_large', `Atomic execution is limited to ${MAX_ATOMIC_CALLS} calls`, { chain, screening });
  }
  try {
    validateBaseCalls(chain.chainId, input.calls);
  } catch (error) {
    return blocked('invalid_base_calls', error, { chain, screening });
  }

  const semanticResult = decodeSemantics(chain, input.actionType, input.calls);
  if (!semanticResult.success) {
    return blocked(semanticResult.code, semanticResult.reason, { chain, screening });
  }

  let simulation: SimulationResult;
  try {
    simulation = await simulateTrade({
      chain: String(chain.chainId),
      calls: input.calls,
      instruction: input.instruction,
      memoryMd: input.memoryMd,
    });
  } catch (error) {
    return blocked('preflight_error', error, { chain, screening, semantics: semanticResult.semantics });
  }
  if (!simulation.allowed || !simulation.success) {
    return blocked('preflight_blocked', simulation.reason || simulation.error || 'Preflight validation blocked action', {
      chain,
      screening,
      simulation,
      semantics: semanticResult.semantics,
    });
  }

  const contractSecurity = evaluateContractSecurity(
    input,
    semanticResult.semantics.tokenAddresses,
    requiresContractSecurity,
  );
  if (contractSecurity.status === 'blocked') {
    return blocked('contract_security_blocked', contractSecurity.warnings.join('; ') || 'Contract security gate blocked action', {
      chain,
      screening,
      simulation,
      semantics: semanticResult.semantics,
      contractSecurity,
    });
  }

  return {
    success: true,
    allowed: true,
    code: 'allowed',
    chain,
    screening,
    simulation,
    semantics: semanticResult.semantics,
    contractSecurity,
  };
}

function decodeSemantics(
  chain: NormalizedBaseChain,
  actionType: ExecutableActionType,
  calls: BaseCall[],
): { success: true; semantics: ExecutionSemantics } | { success: false; code: string; reason: string } {
  const canonicalUsdc = canonicalUsdcForBaseChain(chain.chainId).toLowerCase();
  const recipients: string[] = [];
  const spenders: string[] = [];
  const tokenAddresses = new Set<string>();
  let spendAmountRaw = 0n;

  for (const call of calls) {
    if (call.to.toLowerCase() !== canonicalUsdc) {
      return { success: false, code: 'noncanonical_token', reason: 'Executable actions support only canonical Base USDC' };
    }
    if (parseValue(call.value) !== 0n) {
      return { success: false, code: 'native_value_blocked', reason: 'Executable actions cannot include native value transfers' };
    }
    const decoded = decodeErc20Call(call.data);
    if (!decoded) {
      return { success: false, code: 'malformed_calldata', reason: 'ERC-20 calldata is malformed or non-canonical' };
    }
    tokenAddresses.add(canonicalUsdc);

    if (actionType === 'revoke_approval') {
      if (decoded.selector !== APPROVE_SELECTOR || decoded.amount !== 0n) {
        return { success: false, code: 'action_calldata_mismatch', reason: 'revoke_approval must encode only approve(spender, 0)' };
      }
      if (decoded.account === ZERO_ADDRESS) {
        return { success: false, code: 'zero_spender', reason: 'Approval spender cannot be the zero address' };
      }
      spenders.push(decoded.account);
      continue;
    }

    if (decoded.selector !== TRANSFER_SELECTOR || decoded.amount <= 0n) {
      return { success: false, code: 'action_calldata_mismatch', reason: 'limited_transfer must encode only positive USDC transfers' };
    }
    if (decoded.account === ZERO_ADDRESS) {
      return { success: false, code: 'zero_recipient', reason: 'Transfer recipient cannot be the zero address' };
    }
    recipients.push(decoded.account);
    spendAmountRaw += decoded.amount;
  }

  if (spendAmountRaw > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { success: false, code: 'amount_too_large', reason: 'USDC amount exceeds safe accounting range' };
  }

  return {
    success: true,
    semantics: {
      actionType,
      tokenAddresses: [...tokenAddresses],
      recipients,
      spenders,
      spendAmountRaw: spendAmountRaw.toString(),
      spendAmountUsdc: Number(spendAmountRaw) / Number(USDC_DECIMALS),
    },
  };
}

function decodeErc20Call(data?: string): { selector: string; account: string; amount: bigint } | null {
  const normalized = data?.toLowerCase();
  if (!normalized || !/^0x[0-9a-f]+$/.test(normalized) || normalized.length !== 138) return null;
  const selector = normalized.slice(0, 10);
  if (selector !== APPROVE_SELECTOR && selector !== TRANSFER_SELECTOR) return null;
  const accountWord = normalized.slice(10, 74);
  const amountWord = normalized.slice(74, 138);
  if (!accountWord.startsWith(ZERO_PADDING)) return null;
  try {
    return {
      selector,
      account: `0x${accountWord.slice(24)}`,
      amount: BigInt(`0x${amountWord}`),
    };
  } catch {
    return null;
  }
}

function evaluateContractSecurity(
  input: ExecutionGuardInput,
  addresses: string[],
  required: boolean,
): ExecutionGuardResult['contractSecurity'] {
  if (!required) return contractState(input, false, 'skipped');
  const provider = input.providerContext?.securityProvider || input.providerContext?.riskProvider || 'none';
  if (provider !== 'goplus') {
    return contractState(input, true, 'blocked', ['A live contract security check is required for mainnet transfers']);
  }

  const results = input.tokenSecurity || [];
  const warnings: string[] = [];
  let hasWarning = false;
  for (const address of addresses) {
    const result = results.find((entry) => entry.address.toLowerCase() === address.toLowerCase());
    if (!result || result.provider !== 'goplus' || result.status === 'failed' || result.status === 'unknown') {
      warnings.push(`No usable contract security verdict for ${address}`);
      continue;
    }
    if (result.status === 'high-risk') {
      warnings.push(result.summary || `Contract security check marked ${address} high-risk`);
      continue;
    }
    if (result.status === 'warning') {
      hasWarning = true;
      warnings.push(result.summary || `Contract security check reported warnings for ${address}`);
    }
  }

  const blockedResult = addresses.some((address) => {
    const result = results.find((entry) => entry.address.toLowerCase() === address.toLowerCase());
    return !result || result.provider !== 'goplus' || ['failed', 'unknown', 'high-risk'].includes(result.status);
  });
  return contractState(input, true, blockedResult ? 'blocked' : hasWarning ? 'warning' : 'passed', warnings, addresses);
}

function contractState(
  input: ExecutionGuardInput,
  required: boolean,
  status: ExecutionGuardResult['contractSecurity']['status'],
  warnings: string[] = [],
  checkedAddresses: string[] = [],
): ExecutionGuardResult['contractSecurity'] {
  return {
    required,
    status,
    provider: input.providerContext?.securityProvider || input.providerContext?.riskProvider || 'none',
    checkedAddresses,
    warnings,
  };
}

function parseValue(value?: string): bigint {
  if (!value) return 0n;
  try {
    return BigInt(value);
  } catch {
    return -1n;
  }
}

function blocked(
  code: string,
  reason: unknown,
  extra: Partial<ExecutionGuardResult> = {},
): ExecutionGuardResult {
  return {
    success: false,
    allowed: false,
    code,
    reason: reason instanceof Error ? reason.message : String(reason),
    contractSecurity: extra.contractSecurity || {
      required: false,
      status: 'skipped',
      provider: 'none',
      checkedAddresses: [],
      warnings: [],
    },
    ...extra,
  };
}
