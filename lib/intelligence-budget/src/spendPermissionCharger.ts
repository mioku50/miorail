// T60 decision 1 — INTERFACE + types only, no implementation. The real
// on-chain implementation (a thin wrapper over `base.subscription.charge` +
// `SpendPermissionRepository.incrementSpent`) lives in api-server and is
// injected wherever `SpendPermissionCharger` is expected; unit tests here
// inject a mock. Neither this file nor any other file in this package ever
// imports `@base-org/account`, `@coinbase/cdp-sdk`, viem, wagmi, or react.

/**
 * Structural mirror of `@mioagent/autonomy`'s `SpendPermission` — declared
 * locally rather than imported, because `@mioagent/autonomy` depends on
 * `@base-org/account` (via its `fuel.ts`), which this package must never
 * pull in even transitively. The real `SpendPermission` object already
 * satisfies this shape and is simply passed in wherever it is expected —
 * the same pattern `@mioagent/paid-intelligence`'s coordinator uses for
 * `PaidSimulationSettlementV1` instead of depending on `@mioagent/x402-gateway`.
 */
export interface SpendPermissionSnapshotV1 {
  id: string;
  userId: string;
  chainId?: number;
  asset?: string;
  limit: number;
  spent: number;
  whitelist: string[];
  expiresAt: number;
  isActive: boolean;
}

/** Structural mirror of `@mioagent/autonomy`'s `ConfirmedSettlementProof`. */
export interface ConfirmedSettlementProofV1 {
  txHash?: string;
  batchId?: string;
  receiptId?: string;
  x402ReceiptId?: string;
  confirmedAt?: string;
}

/**
 * Structural mirror of `@mioagent/autonomy`'s `SpendPermissionRepository`,
 * narrowed to the two methods the budget coordinator needs (decision 5):
 * a structural read for validation.ts's own preflight checks, and the
 * idempotent-by-proof increment used only AFTER a real charge succeeds
 * (decision 8 — no duplicate onchain spend, ever).
 */
export interface SpendPermissionSourceV1 {
  getById(id: string): Promise<SpendPermissionSnapshotV1 | undefined>;
  incrementSpent(
    id: string,
    amount: number,
    proof: ConfirmedSettlementProofV1,
  ): Promise<SpendPermissionSnapshotV1 | undefined>;
}

export interface SpendPermissionPreflightInputV1 {
  permissionId: string;
  /** Base-unit atomic amount of the intended charge. */
  amountAtomic: string;
}

export interface SpendPermissionPreflightResultV1 {
  ok: boolean;
  /** Honest, non-internal reason for a failed preflight (e.g. matches
   * FuelChargeService's own status vocabulary: 'permission_inactive',
   * 'subscription_owner_mismatch', 'limit_exhausted', ...). */
  reason?: string;
}

export interface SpendPermissionChargeInputV1 {
  permissionId: string;
  /** Base-unit atomic amount to charge — ALWAYS the reserved cost, never
   * client- or blueprint-supplied (decision 7). */
  amountAtomic: string;
  /** Same idempotency key the reservation was created with (decision 8) —
   * lets the real implementation de-duplicate its own onchain call if the
   * HTTP request is retried before a durable proof was recorded. */
  idempotencyKey: string;
}

export type SpendPermissionChargeResultV1 =
  | { ok: true; proof: ConfirmedSettlementProofV1 }
  | { ok: false; reason: string };

/**
 * Injected dependency (decision 1/13) — Budget NEVER moves user assets
 * itself; every call here is addressed at a single, fixed, server-configured
 * recoup recipient (decision 7). `preflight`/`charge` internally resolve
 * their own expected spender/asset/recipient from the real implementation's
 * closed-over env config — the coordinator never passes (or needs to know)
 * recipient/spender/asset; it only ever supplies permissionId/amountAtomic/
 * idempotencyKey.
 */
export interface SpendPermissionCharger {
  preflight(input: SpendPermissionPreflightInputV1): Promise<SpendPermissionPreflightResultV1>;
  charge(input: SpendPermissionChargeInputV1): Promise<SpendPermissionChargeResultV1>;
}
