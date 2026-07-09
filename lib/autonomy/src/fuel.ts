import { base } from '@base-org/account/node';
import {
  BASE_SEPOLIA_CHAIN_ID,
  canonicalUsdcForBaseChain,
  normalizeBaseChain,
  type SupportedBaseChainId,
} from '@mioagent/security/baseGuards';
import { ConfirmedSettlementProof, SpendPermissionRepository } from './repository';
import { SpendPermission } from './types';

export type FuelCategory = 'inference' | 'premium_data' | 'mcp_tool' | 'execution' | 'dev_smoke';

export interface FuelReservation {
  id: string;
  permissionId: string;
  amount: number;
  category: FuelCategory;
  createdAt: string;
}

export interface FuelChargeOptions {
  walletName?: string;
  paymasterUrl?: string;
}

export interface FuelChargeInput {
  permissionId: string;
  amount: number;
  category: FuelCategory;
  recipient?: string;
  chainEnv?: string | number;
}

export interface FuelChargeResult {
  success: boolean;
  permission?: SpendPermission;
  reservation?: FuelReservation;
  chargeId?: string;
  proof?: ConfirmedSettlementProof;
  error?: string;
  status?: string;
}

type BaseSubscriptionStatus = {
  isSubscribed?: boolean;
  remainingChargeInPeriod?: string | number | null;
};

type BaseChargeResponse = {
  success?: boolean;
  id?: string;
  chargeId?: string;
  transactionHash?: string;
  txHash?: string;
  amount?: string;
};

const reservations = new Map<string, FuelReservation>();

function nowIso(): string {
  return new Date().toISOString();
}

function reservationId(permissionId: string): string {
  return `fuel:${permissionId}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

function numberFrom(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number(value);
  return 0;
}

function pendingForPermission(permissionId: string): number {
  let total = 0;
  for (const reservation of reservations.values()) {
    if (reservation.permissionId === permissionId) total += reservation.amount;
  }
  return total;
}

function deriveChain(chainEnvOrId: string | number | undefined, permission: SpendPermission) {
  const raw = chainEnvOrId ?? permission.chainId ?? process.env.CHAIN_ENV ?? 'sepolia';
  const normalizedRaw = String(raw).trim().toLowerCase();
  if (normalizedRaw === 'mainnet' || normalizedRaw === 'mainnet-readonly') return normalizeBaseChain(8453);
  if (normalizedRaw === 'sepolia') return normalizeBaseChain(BASE_SEPOLIA_CHAIN_ID);
  return normalizeBaseChain(raw);
}

function hasCanonicalAsset(permission: SpendPermission, chainId: SupportedBaseChainId): boolean {
  if (!permission.asset) return true;
  return permission.asset.toLowerCase() === canonicalUsdcForBaseChain(chainId).toLowerCase();
}

function proofFromCharge(charge: BaseChargeResponse): ConfirmedSettlementProof {
  const txHash = charge.transactionHash || charge.txHash;
  return {
    ...(txHash ? { txHash } : {}),
    ...(charge.id || charge.chargeId ? { receiptId: charge.id || charge.chargeId } : {}),
    confirmedAt: nowIso(),
  };
}

function hasDurableProof(proof: ConfirmedSettlementProof): boolean {
  return Boolean(proof.txHash || proof.batchId || proof.receiptId || proof.x402ReceiptId);
}

export function listFuelReservations(permissionId?: string): FuelReservation[] {
  return [...reservations.values()].filter((reservation) => !permissionId || reservation.permissionId === permissionId);
}

export function clearFuelReservationsForTests(): void {
  reservations.clear();
}

export class FuelChargeService {
  constructor(
    private readonly repository: SpendPermissionRepository,
    private readonly options: FuelChargeOptions = {},
  ) {}

  async reserve(input: FuelChargeInput): Promise<FuelChargeResult> {
    const validation = await this.validate(input);
    if (!validation.success || !validation.permission) return validation;

    const reservation: FuelReservation = {
      id: reservationId(input.permissionId),
      permissionId: input.permissionId,
      amount: input.amount,
      category: input.category,
      createdAt: nowIso(),
    };
    reservations.set(reservation.id, reservation);
    return { success: true, permission: validation.permission, reservation, status: 'reserved' };
  }

  release(reservationId: string): void {
    reservations.delete(reservationId);
  }

  async charge(input: FuelChargeInput): Promise<FuelChargeResult> {
    const reserved = await this.reserve(input);
    if (!reserved.success || !reserved.permission || !reserved.reservation) return reserved;

    const chain = deriveChain(input.chainEnv, reserved.permission);
    try {
      const status = await base.subscription.getStatus({
        id: input.permissionId,
        testnet: chain.chainId === BASE_SEPOLIA_CHAIN_ID,
      }) as BaseSubscriptionStatus;
      if (!status.isSubscribed) {
        return { success: false, error: 'Spend permission is not subscribed', status: 'permission_inactive' };
      }
      const remaining = numberFrom(status.remainingChargeInPeriod);
      if (remaining > 0 && remaining < input.amount) {
        return { success: false, error: 'Spend permission period limit exceeded', status: 'limit_exhausted' };
      }

      const charge = await base.subscription.charge({
        id: input.permissionId,
        amount: input.amount.toString(),
        ...(input.recipient ? { recipient: input.recipient } : {}),
        ...(this.options.paymasterUrl ? { paymasterUrl: this.options.paymasterUrl } : {}),
        ...(this.options.walletName ? { walletName: this.options.walletName } : {}),
        testnet: chain.chainId === BASE_SEPOLIA_CHAIN_ID,
      } as never) as BaseChargeResponse;

      if (charge.success === false) {
        return { success: false, error: 'Spend permission charge failed', status: 'charge_failed' };
      }

      const proof = proofFromCharge(charge);
      if (!hasDurableProof(proof)) {
        return { success: false, error: 'Spend permission charge did not return durable proof', status: 'missing_charge_proof' };
      }

      const updated = await this.repository.incrementSpent(input.permissionId, input.amount, proof);
      if (!updated) {
        return { success: false, error: 'Spend limit exceeded or permission inactive', status: 'limit_exhausted' };
      }

      return {
        success: true,
        permission: updated,
        reservation: reserved.reservation,
        chargeId: charge.id || charge.chargeId,
        proof,
        status: 'settled',
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        status: 'charge_failed',
      };
    } finally {
      this.release(reserved.reservation.id);
    }
  }

  private async validate(input: FuelChargeInput): Promise<FuelChargeResult> {
    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      return { success: false, error: 'Invalid fuel amount', status: 'invalid_amount' };
    }
    const permission = await this.repository.getById(input.permissionId);
    if (!permission) return { success: false, error: 'Fuel spend permission not found', status: 'missing_permission' };
    if (!permission.isActive) return { success: false, permission, error: 'Fuel spend permission is inactive', status: 'permission_inactive' };
    if (Date.now() > permission.expiresAt) return { success: false, permission, error: 'Fuel spend permission expired', status: 'permission_expired' };

    let chain;
    try {
      chain = deriveChain(input.chainEnv, permission);
    } catch {
      return { success: false, permission, error: 'Unsupported Base chain for fuel permission', status: 'unsupported_chain' };
    }
    if (permission.chainId && permission.chainId !== chain.chainId) {
      return { success: false, permission, error: `Fuel permission chain mismatch: expected ${permission.chainId}, got ${chain.chainId}`, status: 'chain_mismatch' };
    }
    if (!hasCanonicalAsset(permission, chain.chainId)) {
      return { success: false, permission, error: `Only canonical USDC is supported on Base ${chain.chainId}`, status: 'asset_mismatch' };
    }

    const pending = pendingForPermission(input.permissionId);
    if (permission.spent + pending + input.amount > permission.limit) {
      return { success: false, permission, error: 'Fuel spend limit exceeded', status: 'limit_exhausted' };
    }
    return { success: true, permission, status: 'ready' };
  }
}
