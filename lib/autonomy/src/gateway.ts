import {
  BASE_MAINNET_CHAIN_ID,
  canonicalUsdcForBaseChain,
  normalizeBaseChain,
  screenAction,
  simulateTrade,
  validateBaseCalls,
  type NormalizedBaseChain,
  type ScreenResult,
  type SimulationResult,
} from '@mioagent/security';
import type { Call } from './types';
import type {
  AutonomyExecutionReservation,
  AutonomyPolicy,
  AutonomyPolicyRepository,
} from './policyRepository';

export type AutonomousActionType = 'revoke_approval' | 'limited_transfer';

export interface PrepareAutonomousExecutionInput {
  userId: string;
  actionId: string;
  chainEnv: string | number;
  walletAddress: string;
  actionType: AutonomousActionType;
  calls: Call[];
  instruction: string;
  memoryMd?: string | null;
  reservationTtlMs?: number;
}

export interface AutonomousExecutionGatewayOptions {
  repository: AutonomyPolicyRepository;
  mainnetExecutionEnabled?: boolean | (() => boolean);
}

export interface PreparedAutonomousExecution {
  success: boolean;
  status: string;
  error?: string;
  policy?: AutonomyPolicy;
  reservation?: AutonomyExecutionReservation;
  screening?: ScreenResult;
  simulation?: SimulationResult;
  spendAmountUsdc?: number;
  sendCallsRequest?: {
    version: '2.0.0';
    from: string;
    chainId: NormalizedBaseChain['hexChainId'];
    atomicRequired: true;
    calls: Call[];
  };
  approvalUrl?: string;
  requiresUserApproval?: true;
  broadcasted?: false;
}

interface DecodedCall {
  kind: 'approve' | 'transfer';
  account: string;
  amountRaw: bigint;
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const APPROVE_SELECTOR = '0x095ea7b3';
const TRANSFER_SELECTOR = '0xa9059cbb';
const USDC_DECIMALS = 1_000_000n;

/**
 * Fail-closed boundary for bounded action execution. It validates policy,
 * security and calldata, reserves budget atomically, and returns only an
 * unsigned wallet_sendCalls request for explicit wallet approval.
 */
export class AutonomousExecutionGateway {
  private readonly repository: AutonomyPolicyRepository;
  private readonly mainnetExecutionEnabled?: boolean | (() => boolean);

  constructor(options: AutonomousExecutionGatewayOptions) {
    this.repository = options.repository;
    this.mainnetExecutionEnabled = options.mainnetExecutionEnabled;
  }

  async prepare(input: PrepareAutonomousExecutionInput): Promise<PreparedAutonomousExecution> {
    let chain: NormalizedBaseChain;
    try {
      chain = deriveGatewayChain(input.chainEnv);
    } catch (error) {
      return failure('unsupported_chain', error);
    }

    if (String(input.chainEnv).toLowerCase() === 'mainnet-readonly') {
      return failure('mainnet_readonly', 'Autonomous execution is disabled in mainnet-readonly mode');
    }
    if (chain.chainId === BASE_MAINNET_CHAIN_ID && !this.isMainnetExecutionEnabled()) {
      return failure('mainnet_disabled', 'Mainnet execution requires MAINNET_EXECUTION_ENABLED=true');
    }
    if (!ADDRESS_PATTERN.test(input.walletAddress)) {
      return failure('invalid_wallet', 'A valid wallet address is required');
    }

    const policy = await this.repository.getByUser(input.userId, chain.chainId);
    if (!policy) return failure('missing_policy', 'Autonomy policy not found');
    if (policy.killSwitch || !policy.isActive) {
      return failure('kill_switch', 'Autonomy kill switch is engaged', { policy });
    }
    if (policy.walletAddress !== input.walletAddress.toLowerCase()) {
      return failure('wallet_mismatch', 'Connected wallet does not match the autonomy policy', { policy });
    }
    if (chain.chainId === BASE_MAINNET_CHAIN_ID && !policy.mainnetOptIn) {
      return failure('mainnet_opt_in_required', 'Explicit mainnet autonomy opt-in is required', { policy });
    }
    if (Date.now() >= policy.expiresAt) {
      return failure('permission_expired', 'Autonomy policy expired', { policy });
    }

    try {
      validateBaseCalls(chain.chainId, input.calls);
    } catch (error) {
      return failure('invalid_base_calls', error, { policy });
    }

    const screening = screenAction({ instruction: input.instruction, memoryMd: input.memoryMd });
    if (!screening.allowed) {
      return failure('security_blocked', screening.reason || 'Security screening blocked action', { policy, screening });
    }

    const simulation = await simulateTrade({
      chain: String(chain.chainId),
      calls: input.calls,
      instruction: input.instruction,
      memoryMd: input.memoryMd,
    });
    if (!simulation.allowed) {
      return failure('preflight_blocked', simulation.reason || simulation.error || 'Preflight validation blocked action', {
        policy,
        screening,
        simulation,
      });
    }

    const decoded = decodeBoundedCalls(chain, input.actionType, input.calls, policy.whitelist);
    if (!decoded.success) {
      return failure(decoded.status, decoded.error, { policy, screening, simulation });
    }

    const reservation = await this.repository.reserve({
      policyId: policy.id,
      userId: input.userId,
      actionId: input.actionId,
      amount: decoded.spendAmountUsdc,
      ttlMs: Math.min(input.reservationTtlMs ?? 30 * 60_000, policy.expiresAt - Date.now()),
    });
    if (!reservation.success || !reservation.policy || !reservation.reservation) {
      return failure(reservation.status, reservation.error || 'Autonomy reservation failed', {
        policy: reservation.policy || policy,
        screening,
        simulation,
        spendAmountUsdc: decoded.spendAmountUsdc,
      });
    }

    return {
      success: true,
      status: 'approval_required',
      policy: reservation.policy,
      reservation: reservation.reservation,
      screening,
      simulation,
      spendAmountUsdc: decoded.spendAmountUsdc,
      sendCallsRequest: {
        version: '2.0.0',
        from: input.walletAddress.toLowerCase(),
        chainId: chain.hexChainId,
        atomicRequired: true,
        calls: input.calls,
      },
      approvalUrl: `base-account://wallet_sendCalls?chainId=${chain.hexChainId}`,
      requiresUserApproval: true,
      broadcasted: false,
    };
  }

  private isMainnetExecutionEnabled(): boolean {
    if (typeof this.mainnetExecutionEnabled === 'function') return this.mainnetExecutionEnabled();
    if (typeof this.mainnetExecutionEnabled === 'boolean') return this.mainnetExecutionEnabled;
    return process.env.MAINNET_EXECUTION_ENABLED === 'true';
  }
}

function deriveGatewayChain(chainEnv: string | number): NormalizedBaseChain {
  const raw = String(chainEnv).trim().toLowerCase();
  if (raw === 'mainnet' || raw === 'mainnet-readonly') return normalizeBaseChain(8453);
  if (raw === 'sepolia') return normalizeBaseChain(84532);
  return normalizeBaseChain(chainEnv);
}

function decodeBoundedCalls(
  chain: NormalizedBaseChain,
  actionType: AutonomousActionType,
  calls: Call[],
  whitelist: string[],
): { success: true; spendAmountUsdc: number } | { success: false; status: string; error: string } {
  const canonicalUsdc = canonicalUsdcForBaseChain(chain.chainId).toLowerCase();
  const allowedRecipients = new Set(whitelist.map((address) => address.toLowerCase()));
  let totalRaw = 0n;

  for (const call of calls) {
    if (call.to.toLowerCase() !== canonicalUsdc) {
      return { success: false, status: 'unsupported_call', error: 'Only canonical Base USDC calls can use bounded autonomy' };
    }
    if (parseCallValue(call.value) !== 0n) {
      return { success: false, status: 'native_value_blocked', error: 'Native value transfers are not allowed by bounded autonomy' };
    }
    const decoded = decodeErc20Call(call.data);
    if (!decoded) {
      return { success: false, status: 'unsupported_call', error: 'Malformed or unsupported ERC-20 calldata' };
    }

    if (actionType === 'revoke_approval') {
      if (decoded.kind !== 'approve' || decoded.amountRaw !== 0n) {
        return { success: false, status: 'unsafe_approval', error: 'Revoke actions may only encode approve(spender, 0)' };
      }
      continue;
    }

    if (decoded.kind !== 'transfer' || decoded.amountRaw <= 0n) {
      return { success: false, status: 'unsupported_call', error: 'Limited transfer actions may only encode positive USDC transfers' };
    }
    if (!allowedRecipients.has(decoded.account)) {
      return { success: false, status: 'recipient_not_whitelisted', error: `Recipient ${decoded.account} is not whitelisted` };
    }
    totalRaw += decoded.amountRaw;
  }

  if (totalRaw > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { success: false, status: 'amount_too_large', error: 'USDC amount exceeds safe accounting range' };
  }
  return { success: true, spendAmountUsdc: Number(totalRaw) / Number(USDC_DECIMALS) };
}

function decodeErc20Call(data?: string): DecodedCall | null {
  const normalized = data?.toLowerCase();
  if (!normalized || !/^0x[0-9a-f]+$/.test(normalized) || normalized.length !== 138) return null;
  const selector = normalized.slice(0, 10);
  if (selector !== APPROVE_SELECTOR && selector !== TRANSFER_SELECTOR) return null;
  const accountWord = normalized.slice(10, 74);
  const amountWord = normalized.slice(74, 138);
  const account = `0x${accountWord.slice(24)}`;
  if (!ADDRESS_PATTERN.test(account)) return null;
  try {
    return {
      kind: selector === APPROVE_SELECTOR ? 'approve' : 'transfer',
      account,
      amountRaw: BigInt(`0x${amountWord}`),
    };
  } catch {
    return null;
  }
}

function parseCallValue(value?: string): bigint {
  if (!value) return 0n;
  try {
    return BigInt(value);
  } catch {
    return -1n;
  }
}

function failure(
  status: string,
  error: unknown,
  extra: Partial<PreparedAutonomousExecution> = {},
): PreparedAutonomousExecution {
  return {
    success: false,
    status,
    error: error instanceof Error ? error.message : String(error),
    ...extra,
  };
}
