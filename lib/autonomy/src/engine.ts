import { base } from '@base-org/account';
import { screenAction, simulateTrade } from '@mioagent/security';
import {
  BASE_MAINNET_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  canonicalUsdcForBaseChain,
  normalizeBaseChain,
  validateBaseCalls,
  type NormalizedBaseChain,
} from '@mioagent/security/baseGuards';
import { SpendPermission, Call } from './types';
import {
  ConfirmedSettlementProof,
  InMemorySpendPermissionRepository,
  SpendPermissionRepository,
} from './repository';

export interface MainnetAutonomyOptInStore {
  isEnabled(userId: string): Promise<boolean>;
}

export interface ValidateExecutionOptions {
  chainEnv?: string;
  instruction?: string;
  memoryMd?: string | null;
}

export interface PreparedExecution {
  success: boolean;
  sendCallsRequest?: unknown;
  approvalUrl?: string;
  error?: string;
}

export interface AutonomyEngineOptions {
  repository?: SpendPermissionRepository;
  chainEnv?: string;
  mainnetExecutionEnabled?: boolean | (() => boolean);
  mainnetOptIn?: MainnetAutonomyOptInStore;
}

const DEFAULT_INSTRUCTION = 'Autonomous spend permission execution';

export class AutonomyEngine {
  private readonly repository: SpendPermissionRepository;
  private readonly chainEnv?: string;
  private readonly mainnetExecutionEnabled?: boolean | (() => boolean);
  private readonly mainnetOptIn: MainnetAutonomyOptInStore;

  constructor(options: AutonomyEngineOptions = {}) {
    this.repository = options.repository ?? new InMemorySpendPermissionRepository();
    this.chainEnv = options.chainEnv;
    this.mainnetExecutionEnabled = options.mainnetExecutionEnabled;
    this.mainnetOptIn = options.mainnetOptIn ?? { isEnabled: async () => false };
  }

  async createPermission(permission: SpendPermission): Promise<void> {
    const chain = deriveBaseChain(permission.chainId ?? this.effectiveChainEnv());
    const normalized = normalizePermissionForChain(permission, chain);
    await this.repository.create(normalized);
  }

  async getPermission(id: string): Promise<SpendPermission | undefined> {
    return this.repository.getById(id);
  }

  async killSwitch(id: string): Promise<void> {
    await this.repository.setActive(id, false);
  }

  async validateAndPrepareExecution(
    permissionId: string,
    calls: Call[],
    cost: number = 0,
    options: ValidateExecutionOptions = {},
  ): Promise<PreparedExecution> {
    const perm = await this.repository.getById(permissionId);

    if (!perm) {
      return { success: false, error: 'Permission not found' };
    }

    if (!perm.isActive) {
      return { success: false, error: 'Permission is inactive (kill-switch engaged)' };
    }

    const chain = deriveBaseChain(perm.chainId ?? options.chainEnv ?? this.effectiveChainEnv());
    const readonlyMainnet = (options.chainEnv ?? this.effectiveChainEnv()) === 'mainnet-readonly';

    if (perm.chainId && perm.chainId !== chain.chainId) {
      return { success: false, error: `Permission chain mismatch: expected ${perm.chainId}, got ${chain.chainId}` };
    }

    if (!isCanonicalPermissionAsset(perm, chain)) {
      return { success: false, error: `Only canonical USDC is supported on Base ${chain.chainId}` };
    }

    if (chain.chainId === BASE_MAINNET_CHAIN_ID) {
      const gate = await this.checkMainnetGate(perm.userId, readonlyMainnet);
      if (!gate.allowed) {
        return { success: false, error: gate.error };
      }
    }

    if (Date.now() > perm.expiresAt) {
      return { success: false, error: 'Permission expired' };
    }

    if (!Number.isFinite(cost) || cost < 0) {
      return { success: false, error: 'Invalid spend amount' };
    }

    if (perm.spent + cost > perm.limit) {
      return { success: false, error: 'Spend limit exceeded' };
    }

    for (const call of calls) {
      if (!perm.whitelist.includes(call.to.toLowerCase())) {
        return { success: false, error: `Contract ${call.to} is not whitelisted` };
      }
    }

    const instruction = options.instruction || DEFAULT_INSTRUCTION;
    const screening = screenAction({ instruction, memoryMd: options.memoryMd });
    if (!screening.allowed) {
      return { success: false, error: `Security screening blocked action: ${screening.reason}` };
    }

    const simulation = await simulateTrade({
      chain: String(chain.chainId),
      calls,
      instruction,
      memoryMd: options.memoryMd,
    });
    if (!simulation.allowed) {
      return { success: false, error: simulation.reason || simulation.error || 'Simulation blocked action' };
    }

    try {
      validateBaseCalls(chain.chainId, calls);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Base call validation failed: ${message}` };
    }

    let executionCalls: Call[] = [...calls];

    if (cost > 0) {
      try {
        const chargeCalls = await base.subscription.prepareCharge({
          id: permissionId,
          amount: cost.toString(),
          testnet: chain.chainId === BASE_SEPOLIA_CHAIN_ID,
        });

        const mappedChargeCalls: Call[] = chargeCalls.map(c => ({
          to: c.to as string,
          data: c.data as string,
          value: (c.value || '0').toString(),
        }));

        executionCalls = [...mappedChargeCalls, ...executionCalls];
      } catch (err: unknown) {
        if (err instanceof Error) {
          return { success: false, error: `Failed to prepare spend permission charge: ${err.message}` };
        }
        return { success: false, error: 'Failed to prepare spend permission charge: Unknown error' };
      }
    }

    return {
      success: true,
      approvalUrl: `base-account://wallet_sendCalls?chainId=${chain.hexChainId}`,
      sendCallsRequest: {
        version: '2.0.0',
        from: perm.userId,
        chainId: chain.hexChainId,
        atomicRequired: true,
        calls: executionCalls,
      },
    };
  }

  async recordConfirmedSettlement(
    permissionId: string,
    amount: number,
    proof: ConfirmedSettlementProof,
  ): Promise<{ success: boolean; permission?: SpendPermission; error?: string }> {
    if (!hasDurableSettlementProof(proof)) {
      return { success: false, error: 'Confirmed settlement proof required' };
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return { success: false, error: 'Invalid settlement amount' };
    }

    const updated = await this.repository.incrementSpent(permissionId, amount, proof);
    if (!updated) {
      return { success: false, error: 'Spend limit exceeded or permission inactive' };
    }

    return { success: true, permission: updated };
  }

  async reconcileSpent(
    permissionId: string,
    spent: number,
  ): Promise<{ success: boolean; permission?: SpendPermission; error?: string }> {
    if (!this.repository.reconcileSpent) {
      return { success: false, error: 'Repository does not support reconciliation' };
    }
    const updated = await this.repository.reconcileSpent(permissionId, spent);
    if (!updated) {
      return { success: false, error: 'Reconciliation failed' };
    }
    return { success: true, permission: updated };
  }

  async getSubscriptionStatus(subscriptionId: string, testnet?: boolean) {
    const chain = deriveBaseChain(this.effectiveChainEnv());
    return await base.subscription.getStatus({
      id: subscriptionId,
      testnet: testnet ?? chain.chainId === BASE_SEPOLIA_CHAIN_ID,
    });
  }

  async prepareSubscriptionRevoke(subscriptionId: string, testnet?: boolean) {
    const chain = deriveBaseChain(this.effectiveChainEnv());
    return await base.subscription.prepareRevoke({
      id: subscriptionId,
      testnet: testnet ?? chain.chainId === BASE_SEPOLIA_CHAIN_ID,
    });
  }

  private effectiveChainEnv(): string {
    return this.chainEnv || process.env.CHAIN_ENV || 'sepolia';
  }

  private isMainnetExecutionEnabled(): boolean {
    if (typeof this.mainnetExecutionEnabled === 'function') {
      return this.mainnetExecutionEnabled();
    }
    if (typeof this.mainnetExecutionEnabled === 'boolean') {
      return this.mainnetExecutionEnabled;
    }
    return process.env.MAINNET_EXECUTION_ENABLED === 'true';
  }

  private async checkMainnetGate(userId: string, readonlyMainnet: boolean): Promise<{ allowed: boolean; error?: string }> {
    if (readonlyMainnet) {
      return { allowed: false, error: 'Mainnet autonomy is disabled in mainnet-readonly mode' };
    }
    if (!this.isMainnetExecutionEnabled()) {
      return { allowed: false, error: 'Mainnet autonomy requires MAINNET_EXECUTION_ENABLED=true' };
    }
    if (!(await this.mainnetOptIn.isEnabled(userId))) {
      return { allowed: false, error: 'Mainnet autonomy requires explicit user opt-in' };
    }
    return { allowed: true };
  }
}

export function deriveBaseChain(chainEnvOrId: string | number): NormalizedBaseChain {
  const raw = String(chainEnvOrId).trim().toLowerCase();
  if (raw === 'sepolia') return normalizeBaseChain(BASE_SEPOLIA_CHAIN_ID);
  if (raw === 'mainnet' || raw === 'mainnet-readonly') return normalizeBaseChain(BASE_MAINNET_CHAIN_ID);
  return normalizeBaseChain(chainEnvOrId);
}

function normalizePermissionForChain(permission: SpendPermission, chain: NormalizedBaseChain): SpendPermission {
  const asset = permission.asset ?? canonicalUsdcForBaseChain(chain.chainId);
  const canonical = canonicalUsdcForBaseChain(chain.chainId).toLowerCase();
  if (asset.toLowerCase() !== canonical) {
    throw new Error(`Only canonical USDC is supported on Base ${chain.chainId}`);
  }
  return {
    ...permission,
    chainId: chain.chainId,
    asset,
    whitelist: permission.whitelist.map((address) => address.toLowerCase()),
  };
}

function isCanonicalPermissionAsset(permission: SpendPermission, chain: NormalizedBaseChain): boolean {
  if (!permission.asset) return true;
  return permission.asset.toLowerCase() === canonicalUsdcForBaseChain(chain.chainId).toLowerCase();
}

function hasDurableSettlementProof(proof: ConfirmedSettlementProof): boolean {
  return Boolean(proof?.txHash || proof?.batchId || proof?.receiptId || proof?.x402ReceiptId);
}
