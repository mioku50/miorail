import { z } from 'zod';
import {
  AssetRefV1Schema,
  AtomicAmountV1Schema,
  HashV1Schema,
  IntelligenceCategoryV1Schema,
  TimestampV1Schema,
  financialContentV1,
  financialEntityFieldsV1,
  stableHashV1,
  validateFinancialChronologyV1,
  type AssetRefV1,
  type HashV1,
} from '@mioagent/route-domain';

// T60 decision 2 — reuses the EXISTING IntelligenceCategoryV1Schema
// (route_quote/liquidity/risk/simulation/inference). Asset-movement
// categories (transfer/swap/deposit/borrow/withdraw/purchase/arbitrary_call)
// do not exist in this enum BY CONSTRUCTION — a Budget can never be scoped to
// one, so no additional runtime guard is needed beyond this Zod enum (see
// coordinator.ts's own explicit "never touches blueprint.calls" invariant for
// the other half of decision 7's safety boundary).
export { IntelligenceCategoryV1Schema };

const IntelligenceBudgetV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1('intelligence-budget/v1', z.enum(['active', 'paused', 'revoked', 'expired'])),
    spendPermissionId: z.string().min(1).max(300),
    periodType: z.literal('monthly'),
    /** Always canonical USDC on Base mainnet in T60 — carried explicitly
     * (rather than assumed) so downstream consumers never have to guess it. */
    asset: AssetRefV1Schema,
    periodLimitAtomic: AtomicAmountV1Schema,
    periodSpentAtomic: AtomicAmountV1Schema,
    reservedAtomic: AtomicAmountV1Schema,
    maxPerCallAtomic: AtomicAmountV1Schema,
    /** Non-empty, closed to IntelligenceCategoryV1Schema — never an
     * asset-movement kind (transfer/swap/deposit/borrow/withdraw/purchase/
     * arbitrary_call are not members of this enum). */
    allowedCategories: z.array(IntelligenceCategoryV1Schema).min(1).max(IntelligenceCategoryV1Schema.options.length),
    periodStartedAt: TimestampV1Schema.nullable(),
    periodEndsAt: TimestampV1Schema.nullable(),
    revokedAt: TimestampV1Schema.nullable(),
    budgetHash: HashV1Schema,
  })
  .strict();

export type IntelligenceBudgetV1 = z.infer<typeof IntelligenceBudgetV1ObjectSchema>;

/**
 * `periodSpentAtomic`/`reservedAtomic` are excluded alongside `budgetHash`
 * itself (on top of financialContentV1's own id/createdAt/updatedAt/status
 * exclusion) — decision 4's reserve/settle/release/expire methods are
 * single-statement Neon-safe SQL CTEs that increment/decrement these two
 * columns directly in the database and can never recompute a SHA-256
 * canonical-JSON hash inline. Treating them as hash content would make
 * `budgetHash` go stale (and `IntelligenceBudgetV1Schema` fail closed) the
 * moment the very first reservation is made. `budgetHash` therefore
 * fingerprints the budget's POLICY (limits, categories, permission binding)
 * — its live ledger counters stay protected by the CTEs' own WHERE-clause
 * gating and the table's CHECK constraints instead.
 */
export function hashIntelligenceBudgetV1(value: IntelligenceBudgetV1): HashV1 {
  return stableHashV1(
    'intelligence-budget/v1',
    financialContentV1(value, ['budgetHash', 'periodSpentAtomic', 'reservedAtomic']),
  );
}

export const IntelligenceBudgetV1Schema = IntelligenceBudgetV1ObjectSchema.superRefine((value, ctx) => {
  validateFinancialChronologyV1(value, ctx);
  if (value.budgetHash !== hashIntelligenceBudgetV1(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['budgetHash'],
      message: 'budgetHash does not match the canonical V1 financial payload',
    });
  }
  if (BigInt(value.maxPerCallAtomic) > BigInt(value.periodLimitAtomic)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maxPerCallAtomic'],
      message: 'Per-call maximum must not exceed the monthly period limit',
    });
  }
  if (new Set(value.allowedCategories).size !== value.allowedCategories.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['allowedCategories'],
      message: 'allowedCategories must not contain duplicates',
    });
  }
  if (value.status === 'revoked' && value.revokedAt === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['revokedAt'],
      message: 'A revoked Intelligence Budget requires revokedAt',
    });
  }
  if (value.status !== 'revoked' && value.revokedAt !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['revokedAt'],
      message: 'Only a revoked Intelligence Budget may carry revokedAt',
    });
  }
});

const IntelligenceBudgetReservationV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1(
      'intelligence-budget-reservation/v1',
      z.enum(['reserved', 'settled', 'released', 'expired']),
    ),
    budgetId: z.string().min(1).max(200),
    asset: AssetRefV1Schema,
    amountAtomic: AtomicAmountV1Schema,
    idempotencyKey: z.string().min(1).max(300),
    expiresAt: TimestampV1Schema,
  })
  .strict();

export type IntelligenceBudgetReservationV1 = z.infer<typeof IntelligenceBudgetReservationV1ObjectSchema>;

export const IntelligenceBudgetReservationV1Schema = IntelligenceBudgetReservationV1ObjectSchema.superRefine(
  (value, ctx) => {
    validateFinancialChronologyV1(value, ctx);
    if (BigInt(value.amountAtomic) <= 0n) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['amountAtomic'],
        message: 'A reservation amount must be positive',
      });
    }
  },
);

// --- route-storage <-> domain mapping ---------------------------------------
// route-storage deliberately stores flat, un-hashed records (no route-domain
// dependency, no reverse edge — see route-storage/src/types.ts). These
// mappers are the ONLY place that shape gets promoted into a validated,
// hashed IntelligenceBudgetV1 / IntelligenceBudgetReservationV1.

/** Structural mirror of route-storage's IntelligenceBudgetRecord — declared
 * locally (not imported) so this module has exactly one direction of
 * dependency (route-storage never depends back on this package). */
export interface IntelligenceBudgetRecordLikeV1 {
  id: string;
  schemaVersion: string;
  userId: string;
  walletAddress: string;
  chainId: number;
  spendPermissionId: string;
  status: 'active' | 'paused' | 'revoked' | 'expired';
  periodType: 'monthly';
  periodLimitAtomic: string;
  periodSpentAtomic: string;
  reservedAtomic: string;
  maxPerCallAtomic: string;
  allowedCategories: string[];
  periodStartedAt: string | null;
  periodEndsAt: string | null;
  revokedAt: string | null;
  budgetHash: string;
  createdAt: string;
  updatedAt: string;
}

export function intelligenceBudgetV1FromRecord(
  record: IntelligenceBudgetRecordLikeV1,
  asset: AssetRefV1,
): IntelligenceBudgetV1 {
  return IntelligenceBudgetV1Schema.parse({
    schemaVersion: 'intelligence-budget/v1',
    id: record.id,
    tenantId: record.userId,
    // route-storage's IntelligenceBudgetRecord deliberately stores these as
    // plain string/number/string[] (no route-domain dependency — see the
    // interface's own doc comment). The casts below hand the raw DB shape to
    // Zod's `.parse`, which is the actual runtime authority on whether it is
    // a well-formed 0x-address / BaseChainIdV1 / IntelligenceCategoryV1[] /
    // HashV1 — a malformed value throws here, it is never silently coerced.
    walletAddress: record.walletAddress as IntelligenceBudgetV1['walletAddress'],
    chainId: record.chainId as IntelligenceBudgetV1['chainId'],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    status: record.status,
    spendPermissionId: record.spendPermissionId,
    periodType: record.periodType,
    asset,
    periodLimitAtomic: record.periodLimitAtomic,
    periodSpentAtomic: record.periodSpentAtomic,
    reservedAtomic: record.reservedAtomic,
    maxPerCallAtomic: record.maxPerCallAtomic,
    allowedCategories: record.allowedCategories as IntelligenceBudgetV1['allowedCategories'],
    periodStartedAt: record.periodStartedAt,
    periodEndsAt: record.periodEndsAt,
    revokedAt: record.revokedAt,
    budgetHash: record.budgetHash as IntelligenceBudgetV1['budgetHash'],
  } satisfies IntelligenceBudgetV1);
}

export interface IntelligenceBudgetReservationRecordLikeV1 {
  id: string;
  schemaVersion: string;
  budgetId: string;
  userId: string;
  amountAtomic: string;
  status: 'reserved' | 'settled' | 'released' | 'expired';
  idempotencyKey: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export function intelligenceBudgetReservationV1FromRecord(
  record: IntelligenceBudgetReservationRecordLikeV1,
  budget: IntelligenceBudgetV1,
): IntelligenceBudgetReservationV1 {
  return IntelligenceBudgetReservationV1Schema.parse({
    schemaVersion: 'intelligence-budget-reservation/v1',
    id: record.id,
    tenantId: record.userId,
    walletAddress: budget.walletAddress,
    chainId: budget.chainId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    status: record.status,
    budgetId: record.budgetId,
    asset: budget.asset,
    amountAtomic: record.amountAtomic,
    idempotencyKey: record.idempotencyKey,
    expiresAt: record.expiresAt,
  } satisfies IntelligenceBudgetReservationV1);
}
