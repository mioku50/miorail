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
} from '../routes/x402/index.js';

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
 * ONLY place T60's atomic-string contract crosses into that decimal API. */
function atomicUsdcToDecimalNumber(amountAtomic: string): number {
  return Number(amountAtomic) / 1_000_000;
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
  const fuel = new FuelChargeService(repository, {
    walletName: subscriptionWalletName(env),
    paymasterUrl: env.PAYMASTER_URL,
    rpcUrl: rpcUrlForNetwork('eip155:8453', env),
  });

  async function resolveOwnerAddress(): Promise<string | null> {
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

      const fuelInput = {
        permissionId: input.permissionId,
        amount: atomicUsdcToDecimalNumber(input.amountAtomic),
        category: INTELLIGENCE_BUDGET_FUEL_CATEGORY,
        chainEnv: 'mainnet',
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

      const result = await fuel.charge({
        permissionId: input.permissionId,
        amount: atomicUsdcToDecimalNumber(input.amountAtomic),
        category: INTELLIGENCE_BUDGET_FUEL_CATEGORY,
        chainEnv: 'mainnet',
        expectedSubscriptionOwner: ownerAddress,
      });
      if (!result.success || !result.proof) {
        return { ok: false, reason: honestReason(result.status, 'spend_permission_charge_failed') };
      }
      return { ok: true, proof: result.proof };
    },
  };
}
