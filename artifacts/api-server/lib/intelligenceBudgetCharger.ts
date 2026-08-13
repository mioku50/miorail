import { FuelChargeService, createDatabaseSpendPermissionRepository, type SpendPermissionRepository } from '@mioagent/autonomy';
import type {
  SpendPermissionCharger,
  SpendPermissionChargeInputV1,
  SpendPermissionChargeResultV1,
  SpendPermissionPreflightInputV1,
  SpendPermissionPreflightResultV1,
} from '@mioagent/intelligence-budget';
import { client } from '@mioagent/db';
import {
  getSubscriptionOwnerWallet,
  rpcUrlForNetwork,
  subscriptionWalletName,
} from './subscriptionOwner.js';
import {
  PostgresSpendPermissionChargeAttemptStoreV1,
  type SpendPermissionChargeAttemptStoreV1,
} from './spendPermissionChargeAttempts.js';

// T60 decision 1/7/13 — the REAL on-chain SpendPermissionCharger. This is a
// thin wrapper over the EXISTING FuelChargeService (lib/autonomy/src/fuel.ts,
// used today by the buyer-smoke reserve->pay->charge cycle) and the CDP
// subscription-owner wallet resolution already used by routes/x402/index.ts —
// neither is reinvented here. It NEVER moves user assets: `charge` only ever
// executes `base.subscription.charge` (via FuelChargeService), which spends
// the user's OWN pre-existing Spend Permission into the fixed,
// server-configured subscription-owner wallet — the same recoup recipient
// every other Miorail Spend-Permission-funded flow already uses. The amount
// charged is ALWAYS the caller-supplied `amountAtomic` (the coordinator's own
// reserved cost) — this module never reads blueprint.calls, never reads a
// client-supplied recipient, and never signs/broadcasts anything itself
// (Base Account's CDP-managed subscription-owner wallet does that, exactly
// as it already does for Agent Fuel).
//
// `incrementSpent` is deliberately NOT called here — `runBudgetSimulationV1`
// calls it itself (via the SAME `SpendPermissionRepository`, wired below as
// `SpendPermissionSourceV1`) immediately after a successful `charge()`.
// FuelChargeService.chargeReserved happens to also call `incrementSpent`
// internally (proof-keyed) before returning — harmless: the ledger's own
// proof-based idempotency (lib/autonomy/src/repository.ts) makes the
// coordinator's second call a guaranteed no-op, never a double-spend.

/** USDC has 6 decimals; Base Account's subscription API and FuelChargeService
 * both take a plain decimal `number` (never atomic/BigInt) — this is the
 * ONLY place T60's atomic-string contract crosses into that decimal API.
 * Refuse values above Number.MAX_SAFE_INTEGER instead of silently rounding a
 * financial amount. */
function atomicUsdcToDecimalNumber(amountAtomic: string): number | null {
  let atomic: bigint;
  try {
    atomic = BigInt(amountAtomic);
  } catch {
    return null;
  }
  if (atomic <= 0n || atomic > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(atomic) / 1_000_000;
}

// Reuses the CLOSEST existing ledger category (X402LedgerEntry/FuelCategory
// has no 'simulation'/'intelligence' member) — purely a bookkeeping label;
// FuelChargeService's own limit accounting is per-permission, not
// per-category (see fuel.ts's pendingForPermission), so this choice has no
// effect on correctness.
const INTELLIGENCE_BUDGET_FUEL_CATEGORY = 'inference' as const;

export interface IntelligenceBudgetChargerOptions {
  repository?: SpendPermissionRepository;
  env?: NodeJS.ProcessEnv;
  fuel?: Pick<FuelChargeService, 'reserve' | 'release' | 'preflightReserved' | 'charge'>;
  attemptStore?: SpendPermissionChargeAttemptStoreV1;
  now?: () => Date;
  ownerAddressResolver?: () => Promise<string | null>;
  inflightTtlMs?: number;
}

const DEFAULT_CHARGE_INFLIGHT_TTL_MS = 5 * 60_000;

function chargeInflightTtlMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.MIORAIL_SPEND_PERMISSION_CHARGE_INFLIGHT_TTL_SECONDS || '300');
  return Number.isFinite(raw) && raw >= 30 && raw <= 3600
    ? Math.trunc(raw * 1000)
    : DEFAULT_CHARGE_INFLIGHT_TTL_MS;
}

/** Honest, non-internal status vocabulary only — FuelChargeService's own
 * `.status` field (e.g. 'permission_inactive', 'subscription_owner_mismatch',
 * 'limit_exhausted', 'charge_failed', ...), NEVER `.error` (which may carry a
 * raw exception message). Matches spendPermissionCharger.ts's own contract. */
function honestReason(status: string | undefined, fallback: string): string {
  return status ?? fallback;
}

export function createIntelligenceBudgetCharger(
  options: IntelligenceBudgetChargerOptions = {},
): SpendPermissionCharger {
  const env = options.env ?? process.env;
  const repository = options.repository ?? createDatabaseSpendPermissionRepository(client);
  const fuel = options.fuel ?? new FuelChargeService(repository, {
      walletName: subscriptionWalletName(env),
      paymasterUrl: env.PAYMASTER_URL,
      rpcUrl: rpcUrlForNetwork('eip155:8453', env),
    });
  const attempts = options.attemptStore ?? new PostgresSpendPermissionChargeAttemptStoreV1();
  const now = options.now ?? (() => new Date());
  const inflightTtlMs = options.inflightTtlMs ?? chargeInflightTtlMs(env);

  async function resolveOwnerAddress(): Promise<string | null> {
    if (options.ownerAddressResolver) return options.ownerAddressResolver();
    try {
      const wallet = await getSubscriptionOwnerWallet(env);
      return wallet.address;
    } catch {
      return null;
    }
  }

  return {
    async preflight(input: SpendPermissionPreflightInputV1): Promise<SpendPermissionPreflightResultV1> {
      const ownerAddress = await resolveOwnerAddress();
      if (!ownerAddress) return { ok: false, reason: 'subscription_owner_unavailable' };
      const amount = atomicUsdcToDecimalNumber(input.amountAtomic);
      if (amount === null) return { ok: false, reason: 'invalid_amount' };

      const fuelInput = {
        permissionId: input.permissionId,
        amount,
        category: INTELLIGENCE_BUDGET_FUEL_CATEGORY,
        chainEnv: 'mainnet',
        expectedPayer: input.expectedPayer,
      };
      const reserved = await fuel.reserve(fuelInput);
      if (!reserved.success || !reserved.reservation) {
        return { ok: false, reason: honestReason(reserved.status, 'spend_permission_preflight_failed') };
      }
      try {
        const preflighted = await fuel.preflightReserved(
          { ...fuelInput, expectedSubscriptionOwner: ownerAddress },
          reserved.reservation,
        );
        if (!preflighted.success) {
          return { ok: false, reason: honestReason(preflighted.status, 'spend_permission_preflight_failed') };
        }
        return { ok: true };
      } finally {
        // This preflight NEVER moves money — always release, never settle.
        fuel.release(reserved.reservation.id);
      }
    },

    async charge(input: SpendPermissionChargeInputV1): Promise<SpendPermissionChargeResultV1> {
      const ownerAddress = await resolveOwnerAddress();
      if (!ownerAddress) return { ok: false, reason: 'subscription_owner_unavailable' };
      const amount = atomicUsdcToDecimalNumber(input.amountAtomic);
      if (amount === null) return { ok: false, reason: 'invalid_amount' };

      let claim;
      try {
        claim = await attempts.claim({
          idempotencyKey: input.idempotencyKey,
          chargeId: input.chargeId,
          userId: input.tenantId,
          spendPermissionId: input.permissionId,
          expectedPayer: input.expectedPayer,
          amountAtomic: input.amountAtomic,
          now: now().toISOString(),
        });
      } catch {
        // The durable claim is a prerequisite for the external side effect.
        // Storage unavailable therefore means no charge is attempted.
        return {
          ok: false,
          reason: 'spend_permission_charge_attempt_storage_unavailable',
          disposition: 'retry_later',
        };
      }

      if (claim.outcome === 'conflict') {
        return {
          ok: false,
          reason: 'spend_permission_charge_attempt_conflict',
          disposition: 'reconciliation_required',
        };
      }
      if (claim.outcome === 'existing') {
        if (claim.attempt.status === 'settled' && claim.attempt.proof) {
          return { ok: true, proof: claim.attempt.proof };
        }
        const ageMs = now().getTime() - Date.parse(claim.attempt.updatedAt);
        if (claim.attempt.status === 'claimed' && ageMs < inflightTtlMs) {
          return {
            ok: false,
            reason: 'spend_permission_charge_in_progress',
            disposition: 'retry_later',
          };
        }
        if (claim.attempt.status === 'claimed') {
          await attempts.markOutcomeUnknown({
            idempotencyKey: input.idempotencyKey,
            now: now().toISOString(),
          }).catch(() => null);
        }
        return {
          ok: false,
          reason: 'spend_permission_charge_outcome_unknown',
          disposition: 'reconciliation_required',
        };
      }

      try {
        const result = await fuel.charge({
          permissionId: input.permissionId,
          amount,
          category: INTELLIGENCE_BUDGET_FUEL_CATEGORY,
          chainEnv: 'mainnet',
          expectedSubscriptionOwner: ownerAddress,
          expectedPayer: input.expectedPayer,
        });
        // Fuel may return success=false together with a durable proof when the
        // Base charge settled but local accounting needs reconciliation. The
        // proof, not the boolean, is authoritative for "must never charge
        // again"; the coordinator retries proof-keyed accounting separately.
        if (result.proof) {
          const settled = await attempts.settle({
            idempotencyKey: input.idempotencyKey,
            proof: result.proof,
            now: now().toISOString(),
          });
          if (!settled || settled.status !== 'settled' || !settled.proof) {
            return {
              ok: false,
              reason: 'spend_permission_charge_proof_persist_failed',
              disposition: 'reconciliation_required',
            };
          }
          return { ok: true, proof: settled.proof };
        }
        await attempts.markOutcomeUnknown({
          idempotencyKey: input.idempotencyKey,
          now: now().toISOString(),
        }).catch(() => null);
        return {
          ok: false,
          reason: honestReason(result.status, 'spend_permission_charge_failed'),
          disposition: 'reconciliation_required',
        };
      } catch {
        await attempts.markOutcomeUnknown({
          idempotencyKey: input.idempotencyKey,
          now: now().toISOString(),
        }).catch(() => null);
        return {
          ok: false,
          reason: 'spend_permission_charge_outcome_unknown',
          disposition: 'reconciliation_required',
        };
      }
    },
  };
}
