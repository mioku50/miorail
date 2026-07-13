import {
  BASE_MAINNET_CHAIN_ID,
  evaluateExecutableAction,
  normalizeBaseChain,
  type ExecutableActionType,
  type ExecutionGuardProviderContext,
  type ExecutionGuardResult,
  type ExecutionTokenSecurityResult,
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
import type { UniswapSwapContext } from '@mioagent/security/uniswapGuard';

// T44b: the gateway mirrors the unified guard's typed whitelist —
// revoke_approval | limited_transfer | moonwell_*. The reservation/settle/
// release lifecycle is identical for every type (maxPerAction + dailyLimit
// enforced atomically in the repository reserve).
export type AutonomousActionType = ExecutableActionType;

export interface PrepareAutonomousExecutionInput {
  userId: string;
  actionId: string;
  chainEnv: string | number;
  walletAddress: string;
  actionType: AutonomousActionType;
  calls: Call[];
  instruction: string;
  memoryMd?: string | null;
  providerContext?: ExecutionGuardProviderContext;
  tokenSecurity?: ExecutionTokenSecurityResult[];
  /** T44b: server-stored Moonwell context (prepared amount) for moonwell_* types. */
  moonwell?: { amountDecimal: string };
  uniswap?: UniswapSwapContext;
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
  guard?: ExecutionGuardResult;
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

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

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

    const guard = await evaluateExecutableAction({
      chain: String(chain.chainId),
      actionType: input.actionType,
      calls: input.calls,
      instruction: input.instruction,
      memoryMd: input.memoryMd,
      providerContext: input.providerContext,
      tokenSecurity: input.tokenSecurity,
      ...(input.moonwell ? { moonwell: input.moonwell } : {}),
      ...(input.uniswap ? { uniswap: input.uniswap } : {}),
    });
    if (!guard.allowed || !guard.semantics) {
      return failure(guard.code, guard.reason || 'Unified execution guard blocked action', {
        policy,
        screening: guard.screening,
        simulation: guard.simulation,
        guard,
      });
    }

    const allowedRecipients = new Set(policy.whitelist.map((address) => address.toLowerCase()));
    const blockedRecipient = guard.semantics.recipients.find((recipient) => !allowedRecipients.has(recipient));
    if (blockedRecipient) {
      return failure('recipient_not_whitelisted', `Recipient ${blockedRecipient} is not whitelisted`, {
        policy,
        screening: guard.screening,
        simulation: guard.simulation,
        guard,
      });
    }
    const spendAmountUsdc = guard.semantics.spendAmountUsdc;

    const reservation = await this.repository.reserve({
      policyId: policy.id,
      userId: input.userId,
      actionId: input.actionId,
      amount: spendAmountUsdc,
      ttlMs: Math.min(input.reservationTtlMs ?? 30 * 60_000, policy.expiresAt - Date.now()),
    });
    if (!reservation.success || !reservation.policy || !reservation.reservation) {
      return failure(reservation.status, reservation.error || 'Autonomy reservation failed', {
        policy: reservation.policy || policy,
        screening: guard.screening,
        simulation: guard.simulation,
        guard,
        spendAmountUsdc,
      });
    }

    return {
      success: true,
      status: 'approval_required',
      policy: reservation.policy,
      reservation: reservation.reservation,
      screening: guard.screening,
      simulation: guard.simulation,
      guard,
      spendAmountUsdc,
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
