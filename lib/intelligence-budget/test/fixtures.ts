import {
  ExecutionBlueprintV1Schema,
  ZERO_HASH_V1,
  hashExecutionBlueprintV1,
  hashIntelligenceChargeV1,
  IntelligenceChargeV1Schema,
  stableHashV1,
  type ExecutionBlueprintV1,
  type HashV1,
  type IntelligenceChargeV1,
  type MoneyV1,
  type ProviderRefV1,
} from '@mioagent/route-domain';
import {
  FIXTURE_TENANT,
  FIXTURE_WALLET,
  USDC_BASE,
  missingSafetyEvidenceSetFixture,
  validBlueprintFixture,
  validSwapIntentFixture,
  validUniswapCandidateFixture,
} from '@mioagent/route-domain/fixtures';
import { InMemoryRouteStorageRepository, type IntelligenceBudgetRecord } from '@mioagent/route-storage';
import {
  hashIntelligenceBudgetV1,
  IntelligenceBudgetV1Schema,
  type IntelligenceBudgetV1,
} from '../src/budget-contracts.js';

export const TENANT_ID = FIXTURE_TENANT;
export const WALLET_ADDRESS = FIXTURE_WALLET as `0x${string}`;
export const FIXTURE_TIME = '2026-07-20T12:00:00.000Z';

// --- SpendPermission test double ---------------------------------------------
// Structural mirror of `@mioagent/autonomy`'s `SpendPermission` /
// `InMemorySpendPermissionRepository`, reimplemented locally (not imported)
// for two reasons: (1) `@mioagent/autonomy`'s package.json omits
// `"type": "module"`, which breaks a plain ESM named-import of its exports
// under this package's `node --import tsx --test` runner (a pre-existing,
// out-of-scope quirk in that shared package — see the T60 executor report);
// (2) it mirrors spendPermissionCharger.ts's OWN documented reasoning for
// never importing `@mioagent/autonomy` from this package's src, which also
// transitively pulls in `@base-org/account`. Semantics (including the
// proof-keyed idempotent incrementSpent) match the real implementation.

export interface SpendPermission {
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

interface ConfirmedSettlementProof {
  txHash?: string;
  batchId?: string;
  receiptId?: string;
  x402ReceiptId?: string;
  confirmedAt?: string;
}

function proofKey(proof: ConfirmedSettlementProof): string {
  if (proof.txHash) return `tx:${proof.txHash}`;
  if (proof.batchId) return `batch:${proof.batchId}`;
  if (proof.receiptId) return `receipt:${proof.receiptId}`;
  if (proof.x402ReceiptId) return `x402:${proof.x402ReceiptId}`;
  throw new Error('Durable settlement proof required for idempotent spend accounting');
}

function clonePermission(permission: SpendPermission): SpendPermission {
  return { ...permission, whitelist: [...permission.whitelist] };
}

export class TestSpendPermissionRepository {
  private readonly permissions = new Map<string, SpendPermission>();
  // Idempotency ledger mirroring the `spend_permission_proofs` table: once a
  // proof has been applied, a repeated call with the same proof must not
  // double-increment `spent` again.
  private readonly appliedProofs = new Set<string>();

  async create(permission: SpendPermission): Promise<void> {
    this.permissions.set(permission.id, clonePermission(permission));
  }

  async getById(id: string): Promise<SpendPermission | undefined> {
    const permission = this.permissions.get(id);
    return permission ? clonePermission(permission) : undefined;
  }

  async incrementSpent(
    id: string,
    amount: number,
    proof: ConfirmedSettlementProof,
  ): Promise<SpendPermission | undefined> {
    const permission = this.permissions.get(id);
    if (!permission) return undefined;
    const key = proofKey(proof);
    if (this.appliedProofs.has(key)) {
      // Same proof as a previous, successfully APPLIED call: idempotent
      // success, return current state without incrementing again.
      return clonePermission(permission);
    }
    if (!permission.isActive) return undefined;
    if (permission.spent + amount > permission.limit) return undefined;
    this.appliedProofs.add(key);
    const updated = { ...permission, spent: permission.spent + amount };
    this.permissions.set(id, updated);
    return clonePermission(updated);
  }
}

export const SIMULATION_PRICE: MoneyV1 = {
  asset: USDC_BASE,
  amountAtomic: '10000',
  amountDecimal: '0.01',
  usdValue: '0.01',
};

export const SIMULATION_PROVIDER_REF: ProviderRefV1 = {
  id: 'mock-budget-sim-v1',
  displayName: 'Mock Budget Simulation Provider',
  kind: 'simulation',
  operator: 'fixture-operator',
};

function fixtureHash(label: string): HashV1 {
  return stableHashV1('t60-fixture/v1', { label });
}

// Mirrors paid-intelligence's own T59_BLUEPRINT_FIXTURE pattern: points at
// missingSafetyEvidenceSetFixture so tests can observe 'simulation' leaving
// missingEvidence after a paid-via-budget run, and starts simulationState
// honestly 'unavailable' rather than the pre-baked 'passed' on
// validBlueprintFixture.
const blueprintDraft: ExecutionBlueprintV1 = {
  ...validBlueprintFixture,
  id: 'blueprint-t60-fixture',
  evidenceSetHash: missingSafetyEvidenceSetFixture.evidenceSetHash,
  blueprintHash: ZERO_HASH_V1,
  // Overridden well past FIXTURE_TIME (2026-07-20, this package's own "now")
  // — validBlueprintFixture's own quoteExpiry (2026-07-15T09:05) would
  // already have lapsed by then and trip the coordinator's step-1
  // blueprint_expired guard before any budget logic ever runs.
  quoteExpiry: '2027-06-01T00:00:00.000Z',
  simulationState: {
    status: 'unavailable',
    observedAt: null,
    blockNumber: null,
    requestHash: null,
    responseHash: null,
    errorCode: 'no_simulation_provider',
  },
};
export const BUDGET_BLUEPRINT_FIXTURE = ExecutionBlueprintV1Schema.parse({
  ...blueprintDraft,
  blueprintHash: hashExecutionBlueprintV1(blueprintDraft),
});

// --- Intelligence Budget fixtures -------------------------------------------

export interface BudgetFixtureOverrides {
  id?: string;
  tenantId?: string;
  walletAddress?: `0x${string}`;
  spendPermissionId?: string;
  status?: IntelligenceBudgetV1['status'];
  periodLimitAtomic?: string;
  maxPerCallAtomic?: string;
  allowedCategories?: IntelligenceBudgetV1['allowedCategories'];
  periodStartedAt?: string | null;
  periodEndsAt?: string | null;
  revokedAt?: string | null;
  now?: string;
}

/** Builds a schema-valid IntelligenceBudgetV1 (correct budgetHash) — the same
 * "compute with a placeholder hash, then parse with the real one" idiom
 * coordinator.ts itself uses for recomputedBudgetHash/recomputeChargeHash. */
export function budgetDomainFixture(overrides: BudgetFixtureOverrides = {}): IntelligenceBudgetV1 {
  const now = overrides.now ?? FIXTURE_TIME;
  const draft: IntelligenceBudgetV1 = {
    schemaVersion: 'intelligence-budget/v1',
    id: overrides.id ?? 'budget-fixture',
    tenantId: overrides.tenantId ?? TENANT_ID,
    // AddressV1Schema always lowercases on parse — pre-lowercase here too, so
    // the pre-parse hash input and the post-parse superRefine recompute
    // agree even when a caller passes a mixed-case override.
    walletAddress: (overrides.walletAddress ?? WALLET_ADDRESS).toLowerCase() as `0x${string}`,
    chainId: 8453,
    createdAt: now,
    updatedAt: now,
    status: overrides.status ?? 'active',
    spendPermissionId: overrides.spendPermissionId ?? 'permission-fixture',
    periodType: 'monthly',
    asset: USDC_BASE,
    periodLimitAtomic: overrides.periodLimitAtomic ?? '1000000',
    periodSpentAtomic: '0',
    reservedAtomic: '0',
    maxPerCallAtomic: overrides.maxPerCallAtomic ?? '100000',
    allowedCategories: overrides.allowedCategories ?? ['simulation'],
    periodStartedAt: overrides.periodStartedAt === undefined ? now : overrides.periodStartedAt,
    periodEndsAt: overrides.periodEndsAt === undefined ? '2027-01-01T00:00:00.000Z' : overrides.periodEndsAt,
    revokedAt: overrides.revokedAt ?? null,
    budgetHash: ZERO_HASH_V1,
  };
  return IntelligenceBudgetV1Schema.parse({ ...draft, budgetHash: hashIntelligenceBudgetV1(draft) });
}

/** Persists a `budgetDomainFixture` through the route-storage repository,
 * round-tripping the SAME way a real caller (api-server) would: build +
 * validate the domain object first, then project it into the DB-shaped
 * insert input. */
export async function insertBudgetFixture(
  repository: InMemoryRouteStorageRepository,
  overrides: BudgetFixtureOverrides = {},
): Promise<IntelligenceBudgetRecord> {
  const domain = budgetDomainFixture(overrides);
  return repository.insertIntelligenceBudget({
    id: domain.id,
    schemaVersion: domain.schemaVersion,
    userId: domain.tenantId,
    walletAddress: domain.walletAddress,
    chainId: domain.chainId,
    spendPermissionId: domain.spendPermissionId,
    status: domain.status,
    periodType: domain.periodType,
    periodLimitAtomic: domain.periodLimitAtomic,
    maxPerCallAtomic: domain.maxPerCallAtomic,
    allowedCategories: domain.allowedCategories,
    periodStartedAt: domain.periodStartedAt,
    periodEndsAt: domain.periodEndsAt,
    budgetHash: domain.budgetHash,
    now: domain.createdAt,
  });
}

// --- Spend Permission fixtures ----------------------------------------------

export function permissionFixture(overrides: Partial<SpendPermission> = {}): SpendPermission {
  return {
    id: 'permission-fixture',
    userId: TENANT_ID,
    chainId: 8453,
    asset: USDC_BASE.address ?? undefined,
    limit: 1_000_000,
    spent: 0,
    whitelist: [],
    expiresAt: Date.parse('2027-01-01T00:00:00.000Z'),
    isActive: true,
    ...overrides,
  };
}

// --- Combined seed: Route Run + candidate + evidence + blueprint + Budget --

export interface SeedBudgetSimulationOptions {
  budget?: BudgetFixtureOverrides;
  permission?: Partial<SpendPermission>;
}

export interface SeededBudgetSimulationFixture {
  repository: InMemoryRouteStorageRepository;
  spendPermissionRepository: TestSpendPermissionRepository;
  routeRunId: string;
  blueprintId: string;
  budget: IntelligenceBudgetRecord;
  permission: SpendPermission;
}

export async function seedBudgetSimulationFixture(
  options: SeedBudgetSimulationOptions = {},
): Promise<SeededBudgetSimulationFixture> {
  const repository = new InMemoryRouteStorageRepository();
  await repository.createRouteRun(validSwapIntentFixture, 'idem-t60-fixture-run');
  await repository.insertCandidate(validSwapIntentFixture.id, validUniswapCandidateFixture);
  for (const record of missingSafetyEvidenceSetFixture.records) {
    await repository.insertEvidence(validSwapIntentFixture.id, validUniswapCandidateFixture.id, record);
  }
  await repository.insertEvidenceSet(
    validSwapIntentFixture.id,
    validUniswapCandidateFixture.id,
    missingSafetyEvidenceSetFixture,
  );
  await repository.insertBlueprint(validSwapIntentFixture.id, BUDGET_BLUEPRINT_FIXTURE);

  const spendPermissionRepository = new TestSpendPermissionRepository();
  const permission = permissionFixture(options.permission);
  await spendPermissionRepository.create(permission);

  const budget = await insertBudgetFixture(repository, {
    spendPermissionId: permission.id,
    ...options.budget,
  });

  return {
    repository,
    spendPermissionRepository,
    routeRunId: validSwapIntentFixture.id,
    blueprintId: BUDGET_BLUEPRINT_FIXTURE.id,
    budget,
    permission,
  };
}

// --- IntelligenceChargeV1 fixtures (idempotency.ts unit tests) -------------

type ChargeFixtureOverrides = Partial<IntelligenceChargeV1> & { status: IntelligenceChargeV1['status'] };

function chargeFixture(overrides: ChargeFixtureOverrides): IntelligenceChargeV1 {
  const base: Omit<IntelligenceChargeV1, 'chargeHash'> = {
    schemaVersion: 'intelligence-charge/v1',
    id: 'charge-fixture',
    tenantId: TENANT_ID,
    walletAddress: WALLET_ADDRESS,
    chainId: 8453,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    status: 'reserved',
    intentHash: BUDGET_BLUEPRINT_FIXTURE.intentHash,
    candidateHash: BUDGET_BLUEPRINT_FIXTURE.selectedCandidateHash,
    evidenceSetHash: null,
    evidenceHash: null,
    provider: SIMULATION_PROVIDER_REF,
    service: 'transaction-simulation',
    category: 'simulation',
    evidenceType: 'simulation',
    fundingMode: 'spend_permission',
    spendPermissionId: 'permission-fixture',
    intelligenceBudgetId: 'budget-fixture',
    reservationId: 'reservation-fixture',
    quotedCost: SIMULATION_PRICE,
    maxAuthorizedCost: SIMULATION_PRICE,
    chargedCost: null,
    paymentState: 'reserved',
    serviceState: 'not_started',
    x402ReceiptHash: null,
    serviceResponseHash: null,
    idempotencyKey: 'idem-fixture',
  };
  const merged = { ...base, ...overrides };
  const draft = { ...merged, chargeHash: ZERO_HASH_V1 } as IntelligenceChargeV1;
  return IntelligenceChargeV1Schema.parse({ ...draft, chargeHash: hashIntelligenceChargeV1(draft) });
}

/** status 'reserved' — durably inserted, nothing downstream has run yet. */
export function reservedChargeFixture(overrides: Partial<IntelligenceChargeV1> = {}): IntelligenceChargeV1 {
  return chargeFixture({ status: 'reserved', paymentState: 'reserved', serviceState: 'not_started', ...overrides });
}

/** status 'payment_pending' — evidence delivered, Spend Permission charge not
 * yet attempted (or crashed before it ran). */
export function paymentPendingChargeFixture(overrides: Partial<IntelligenceChargeV1> = {}): IntelligenceChargeV1 {
  return chargeFixture({
    status: 'payment_pending',
    paymentState: 'pending',
    serviceState: 'delivered',
    evidenceHash: fixtureHash('evidence'),
    evidenceSetHash: fixtureHash('evidence-set'),
    serviceResponseHash: fixtureHash('response'),
    ...overrides,
  });
}

/** status 'settled' — the ONLY durably-delivered terminal state. */
export function settledChargeFixture(overrides: Partial<IntelligenceChargeV1> = {}): IntelligenceChargeV1 {
  return chargeFixture({
    status: 'settled',
    paymentState: 'settled',
    serviceState: 'delivered',
    evidenceHash: fixtureHash('evidence'),
    evidenceSetHash: fixtureHash('evidence-set'),
    serviceResponseHash: fixtureHash('response'),
    x402ReceiptHash: fixtureHash('proof'),
    chargedCost: SIMULATION_PRICE,
    ...overrides,
  });
}

/** status 'released' — provider or evidence-persist failure; the reservation
 * was already released, the user was never charged. */
export function releasedChargeFixture(overrides: Partial<IntelligenceChargeV1> = {}): IntelligenceChargeV1 {
  return chargeFixture({ status: 'released', paymentState: 'reserved', serviceState: 'failed', ...overrides });
}

/** status 'reconciliation_required' — service delivered, the Spend
 * Permission charge itself failed; must never be auto-retried. */
export function reconciliationRequiredChargeFixture(
  overrides: Partial<IntelligenceChargeV1> = {},
): IntelligenceChargeV1 {
  return chargeFixture({
    status: 'reconciliation_required',
    paymentState: 'failed',
    serviceState: 'delivered',
    evidenceHash: fixtureHash('evidence'),
    evidenceSetHash: fixtureHash('evidence-set'),
    serviceResponseHash: fixtureHash('response'),
    ...overrides,
  });
}
