import type { z } from 'zod';
import type { IntelligenceCategoryV1Schema } from '@mioagent/route-domain';
import type { IntelligenceBudgetV1 } from './budget-contracts.js';
import type { SpendPermissionSnapshotV1 } from './spendPermissionCharger.js';

type IntelligenceCategoryV1 = z.infer<typeof IntelligenceCategoryV1Schema>;

// T60 decision 5.2/5.3/6 — pure guard functions (no I/O, no Date.now()): the
// coordinator supplies `now`, the repository read, and the charger's own
// on-chain preflight result. Every guard here is fail-closed: an unexpected
// or missing field is always treated as a rejection, never a pass.

export type BudgetGuardResultV1 = { ok: true } | { ok: false; outcome: 'blocked' | 'limit_exceeded'; reason: string };

export interface ValidateBudgetForSimulationInputV1 {
  budget: IntelligenceBudgetV1;
  tenantId: string;
  walletAddress: `0x${string}`;
  chainId: 8453;
  category: IntelligenceCategoryV1;
  costAtomic: string;
  now: Date;
}

/**
 * Decision 5.2 — everything the coordinator can decide from the ALREADY
 * loaded Budget alone, before it ever reaches the Spend Permission or the
 * reservation CTE. This is a pre-check only: `reserveIntelligenceBudget`'s
 * own atomic CTE is what finally, authoritatively decides the monthly-limit
 * question under concurrency (decision 8) — this function exists so the
 * coordinator can fail closed to an honest 'blocked'/'limit_exceeded' BEFORE
 * even touching the Spend Permission or the reservation table.
 */
export function validateBudgetForSimulationV1(input: ValidateBudgetForSimulationInputV1): BudgetGuardResultV1 {
  const { budget, tenantId, walletAddress, chainId, category, costAtomic, now } = input;
  if (budget.tenantId !== tenantId) {
    return { ok: false, outcome: 'blocked', reason: 'budget_tenant_mismatch' };
  }
  if (budget.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) {
    return { ok: false, outcome: 'blocked', reason: 'budget_wallet_mismatch' };
  }
  if (budget.chainId !== chainId) {
    return { ok: false, outcome: 'blocked', reason: 'budget_chain_mismatch' };
  }
  if (budget.status === 'revoked' || budget.revokedAt !== null) {
    return { ok: false, outcome: 'blocked', reason: 'budget_revoked' };
  }
  if (budget.status !== 'active') {
    return { ok: false, outcome: 'blocked', reason: `budget_${budget.status}` };
  }
  if (budget.periodEndsAt !== null && Date.parse(budget.periodEndsAt) <= now.getTime()) {
    return { ok: false, outcome: 'blocked', reason: 'budget_period_expired' };
  }
  if (!budget.allowedCategories.includes(category)) {
    return { ok: false, outcome: 'blocked', reason: 'category_not_allowed' };
  }
  const cost = BigInt(costAtomic);
  if (cost > BigInt(budget.maxPerCallAtomic)) {
    return { ok: false, outcome: 'limit_exceeded', reason: 'per_call_limit_exceeded' };
  }
  const projected = BigInt(budget.periodSpentAtomic) + BigInt(budget.reservedAtomic) + cost;
  if (projected > BigInt(budget.periodLimitAtomic)) {
    return { ok: false, outcome: 'limit_exceeded', reason: 'monthly_limit_exceeded' };
  }
  return { ok: true };
}

export interface CheckSpendPermissionInputV1 {
  permission: SpendPermissionSnapshotV1 | undefined;
  tenantId: string;
  now: Date;
  /** Canonical USDC address for the Budget's chain — resolved by the
   * caller (api-server has `@mioagent/security`'s `canonicalUsdcForBaseChain`;
   * this package intentionally does not depend on it). */
  expectedAssetAddress: string;
}

export type SpendPermissionCheckResultV1 = { ok: true } | { ok: false; reason: string };

/**
 * Decision 5.3 (structural half) — everything checkable directly from the
 * Spend Permission snapshot (ownership, active flag, expiry, chain, asset).
 * The on-chain half (allowance/cadence, expected subscription-owner spender)
 * is delegated to `SpendPermissionCharger.preflight` — this package has no
 * way to ask Base Account anything itself (decision 1).
 */
export function checkSpendPermissionV1(input: CheckSpendPermissionInputV1): SpendPermissionCheckResultV1 {
  const { permission, tenantId, now, expectedAssetAddress } = input;
  if (!permission) return { ok: false, reason: 'spend_permission_missing' };
  if (permission.userId !== tenantId) return { ok: false, reason: 'spend_permission_tenant_mismatch' };
  if (!permission.isActive) return { ok: false, reason: 'spend_permission_inactive' };
  if (permission.expiresAt <= now.getTime()) return { ok: false, reason: 'spend_permission_expired' };
  if (permission.chainId !== undefined && permission.chainId !== 8453) {
    return { ok: false, reason: 'spend_permission_chain_mismatch' };
  }
  if (permission.asset !== undefined && permission.asset.toLowerCase() !== expectedAssetAddress.toLowerCase()) {
    return { ok: false, reason: 'spend_permission_asset_mismatch' };
  }
  return { ok: true };
}

export interface CheckSpendPermissionBindingInputV1 {
  permission: SpendPermissionSnapshotV1;
  budget: Pick<IntelligenceBudgetV1, 'spendPermissionId'>;
}

/** The Spend Permission actually backing this Budget — guards against a
 * stale/tampered `budget.spendPermissionId` ever being silently ignored. */
export function checkSpendPermissionBindingV1(input: CheckSpendPermissionBindingInputV1): SpendPermissionCheckResultV1 {
  if (input.permission.id !== input.budget.spendPermissionId) {
    return { ok: false, reason: 'spend_permission_binding_mismatch' };
  }
  return { ok: true };
}
