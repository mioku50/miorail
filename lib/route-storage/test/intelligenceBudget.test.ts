import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryRouteStorageRepository, RouteStorageConflictError, RouteStorageIntegrityError } from '../src/index.js';
import type { InsertIntelligenceBudgetInput } from '../src/index.js';

const USER_A = 'tenant-a';
const USER_B = 'tenant-b';
const WALLET = '0x1111111111111111111111111111111111111111';
const NOW = '2026-07-20T12:00:00.000Z';
const PERIOD_ENDS = '2026-08-20T12:00:00.000Z';

function budgetInput(overrides: Partial<InsertIntelligenceBudgetInput> = {}): InsertIntelligenceBudgetInput {
  return {
    id: 'budget-1',
    schemaVersion: 'intelligence-budget/v1',
    userId: USER_A,
    walletAddress: WALLET,
    chainId: 8453,
    spendPermissionId: 'permission-1',
    status: 'active',
    periodType: 'monthly',
    periodLimitAtomic: '1000000', // 1.0 USDC
    maxPerCallAtomic: '100000', // 0.1 USDC
    allowedCategories: ['simulation'],
    periodStartedAt: NOW,
    periodEndsAt: PERIOD_ENDS,
    budgetHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    now: NOW,
    ...overrides,
  };
}

async function seededRepository(overrides: Partial<InsertIntelligenceBudgetInput> = {}) {
  const repository = new InMemoryRouteStorageRepository();
  const budget = await repository.insertIntelligenceBudget(budgetInput(overrides));
  return { repository, budget };
}

// --- CRUD --------------------------------------------------------------------

test('insertIntelligenceBudget + getIntelligenceBudgetById + getActiveIntelligenceBudget round-trip', async () => {
  const { repository, budget } = await seededRepository();
  assert.equal(budget.status, 'active');
  assert.equal(budget.periodSpentAtomic, '0');
  assert.equal(budget.reservedAtomic, '0');

  const byId = await repository.getIntelligenceBudgetById('budget-1', USER_A);
  assert.deepEqual(byId, budget);

  const active = await repository.getActiveIntelligenceBudget(USER_A, WALLET, 8453);
  assert.deepEqual(active, budget);

  // Tenant isolation on reads.
  assert.equal(await repository.getIntelligenceBudgetById('budget-1', USER_B), null);
  assert.equal(await repository.getActiveIntelligenceBudget(USER_B, WALLET, 8453), null);
});

test('insertIntelligenceBudget rejects a duplicate id and a second active budget on the same permission', async () => {
  const { repository } = await seededRepository();
  await assert.rejects(
    repository.insertIntelligenceBudget(budgetInput({ id: 'budget-1' })),
    RouteStorageConflictError,
  );
  await assert.rejects(
    repository.insertIntelligenceBudget(budgetInput({ id: 'budget-2', spendPermissionId: 'permission-1' })),
    RouteStorageConflictError,
  );
  // A different permission is fine.
  const other = await repository.insertIntelligenceBudget(
    budgetInput({ id: 'budget-3', spendPermissionId: 'permission-2' }),
  );
  assert.equal(other.id, 'budget-3');
});

test('updateIntelligenceBudget recomputes limits/categories/status/hash and fails closed when missing or foreign', async () => {
  const { repository } = await seededRepository();
  const updated = await repository.updateIntelligenceBudget('budget-1', USER_A, {
    periodLimitAtomic: '2000000',
    maxPerCallAtomic: '200000',
    allowedCategories: ['simulation'],
    status: 'paused',
    budgetHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    now: '2026-07-20T13:00:00.000Z',
  });
  assert.equal(updated.periodLimitAtomic, '2000000');
  assert.equal(updated.maxPerCallAtomic, '200000');
  assert.equal(updated.status, 'paused');
  assert.equal(updated.budgetHash, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(updated.updatedAt, '2026-07-20T13:00:00.000Z');

  await assert.rejects(
    repository.updateIntelligenceBudget('missing-budget', USER_A, { budgetHash: '0x', now: NOW }),
    RouteStorageIntegrityError,
  );
  await assert.rejects(
    repository.updateIntelligenceBudget('budget-1', USER_B, { budgetHash: '0x', now: NOW }),
    RouteStorageIntegrityError,
  );
});

test('revoke via updateIntelligenceBudget sets status and revokedAt', async () => {
  const { repository } = await seededRepository();
  const revoked = await repository.updateIntelligenceBudget('budget-1', USER_A, {
    status: 'revoked',
    revokedAt: '2026-07-20T14:00:00.000Z',
    budgetHash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    now: '2026-07-20T14:00:00.000Z',
  });
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.revokedAt, '2026-07-20T14:00:00.000Z');
});

// --- reserveIntelligenceBudget: atomic limit + idempotency + tenant isolation -

test('reserveIntelligenceBudget: happy path increments reserved_atomic and returns the reservation', async () => {
  const { repository } = await seededRepository();
  const result = await repository.reserveIntelligenceBudget({
    budgetId: 'budget-1',
    userId: USER_A,
    reservationId: 'reservation-1',
    amountAtomic: '10000',
    idempotencyKey: 'idem-key-1',
    now: NOW,
    expiresAt: '2026-07-20T12:15:00.000Z',
  });
  assert.equal(result.outcome, 'reserved');
  if (result.outcome !== 'reserved') throw new Error('unreachable');
  assert.equal(result.reservation.status, 'reserved');
  assert.equal(result.reservation.amountAtomic, '10000');
  assert.equal(result.budget.reservedAtomic, '10000');

  const listed = await repository.listIntelligenceBudgetReservations('budget-1', USER_A);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, 'reservation-1');
});

test('reserveIntelligenceBudget: per-call max is enforced -> insufficient, reserved_atomic unchanged', async () => {
  const { repository } = await seededRepository();
  const result = await repository.reserveIntelligenceBudget({
    budgetId: 'budget-1',
    userId: USER_A,
    reservationId: 'reservation-1',
    amountAtomic: '100001', // 1 atomic unit above maxPerCallAtomic (100000)
    idempotencyKey: 'idem-key-1',
    now: NOW,
    expiresAt: '2026-07-20T12:15:00.000Z',
  });
  assert.equal(result.outcome, 'insufficient');
  const budget = await repository.getIntelligenceBudgetById('budget-1', USER_A);
  assert.equal(budget?.reservedAtomic, '0');
});

test('reserveIntelligenceBudget: monthly limit (period_spent + reserved + amount) is enforced -> insufficient', async () => {
  const { repository } = await seededRepository({ periodLimitAtomic: '100000', maxPerCallAtomic: '100000' });
  const first = await repository.reserveIntelligenceBudget({
    budgetId: 'budget-1',
    userId: USER_A,
    reservationId: 'reservation-1',
    amountAtomic: '90000',
    idempotencyKey: 'idem-key-1',
    now: NOW,
    expiresAt: '2026-07-20T12:15:00.000Z',
  });
  assert.equal(first.outcome, 'reserved');

  const second = await repository.reserveIntelligenceBudget({
    budgetId: 'budget-1',
    userId: USER_A,
    reservationId: 'reservation-2',
    amountAtomic: '20000', // 90000 + 20000 > 100000 limit
    idempotencyKey: 'idem-key-2',
    now: NOW,
    expiresAt: '2026-07-20T12:15:00.000Z',
  });
  assert.equal(second.outcome, 'insufficient');

  // The budget's reserved amount reflects ONLY the first, accepted reservation
  // — the rejected second reservation never touched it (the core atomic-limit
  // guarantee: concurrent/sequential reserves never exceed the monthly cap).
  const budget = await repository.getIntelligenceBudgetById('budget-1', USER_A);
  assert.equal(budget?.reservedAtomic, '90000');
  const reservations = await repository.listIntelligenceBudgetReservations('budget-1', USER_A);
  assert.equal(reservations.length, 1);
});

test('reserveIntelligenceBudget: paused/revoked/expired budgets are inactive, never reserved', async () => {
  const { repository: pausedRepo } = await seededRepository({ status: 'paused' });
  const paused = await pausedRepo.reserveIntelligenceBudget({
    budgetId: 'budget-1',
    userId: USER_A,
    reservationId: 'r1',
    amountAtomic: '1000',
    idempotencyKey: 'k1',
    now: NOW,
    expiresAt: '2026-07-20T12:15:00.000Z',
  });
  assert.equal(paused.outcome, 'inactive');

  const { repository: expiredRepo } = await seededRepository({ periodEndsAt: '2026-07-19T00:00:00.000Z' });
  const expired = await expiredRepo.reserveIntelligenceBudget({
    budgetId: 'budget-1',
    userId: USER_A,
    reservationId: 'r2',
    amountAtomic: '1000',
    idempotencyKey: 'k2',
    now: NOW,
    expiresAt: '2026-07-20T12:15:00.000Z',
  });
  assert.equal(expired.outcome, 'inactive');
});

test('reserveIntelligenceBudget: missing or foreign-tenant budget is inactive with no budget leaked', async () => {
  const { repository } = await seededRepository();
  const missing = await repository.reserveIntelligenceBudget({
    budgetId: 'does-not-exist',
    userId: USER_A,
    reservationId: 'r1',
    amountAtomic: '1000',
    idempotencyKey: 'k1',
    now: NOW,
    expiresAt: '2026-07-20T12:15:00.000Z',
  });
  assert.equal(missing.outcome, 'inactive');
  assert.equal(missing.budget, null);

  const foreign = await repository.reserveIntelligenceBudget({
    budgetId: 'budget-1',
    userId: USER_B,
    reservationId: 'r2',
    amountAtomic: '1000',
    idempotencyKey: 'k2',
    now: NOW,
    expiresAt: '2026-07-20T12:15:00.000Z',
  });
  assert.equal(foreign.outcome, 'inactive');
  assert.equal(foreign.budget, null);
});

test('reserveIntelligenceBudget: a retried idempotencyKey replays the SAME reservation without incrementing reserved twice', async () => {
  const { repository } = await seededRepository();
  const input = {
    budgetId: 'budget-1',
    userId: USER_A,
    reservationId: 'reservation-1',
    amountAtomic: '10000',
    idempotencyKey: 'idem-key-retry',
    now: NOW,
    expiresAt: '2026-07-20T12:15:00.000Z',
  };
  const first = await repository.reserveIntelligenceBudget(input);
  assert.equal(first.outcome, 'reserved');

  // Retried with a DIFFERENT reservationId/amount (as a real retry with a
  // slightly different call shape might be) — the idempotency key alone
  // must gate this, returning the ORIGINAL reservation untouched.
  const second = await repository.reserveIntelligenceBudget({
    ...input,
    reservationId: 'reservation-should-be-ignored',
    amountAtomic: '99999',
  });
  assert.equal(second.outcome, 'idempotent_replay');
  if (second.outcome !== 'idempotent_replay') throw new Error('unreachable');
  assert.equal(second.reservation.id, 'reservation-1');
  assert.equal(second.reservation.amountAtomic, '10000');

  const budget = await repository.getIntelligenceBudgetById('budget-1', USER_A);
  assert.equal(budget?.reservedAtomic, '10000'); // NOT double-applied
  const reservations = await repository.listIntelligenceBudgetReservations('budget-1', USER_A);
  assert.equal(reservations.length, 1);
});

// --- settle / release ---------------------------------------------------------

test('settleIntelligenceReservation: moves the amount from reserved to period_spent, is idempotent', async () => {
  const { repository } = await seededRepository();
  await repository.reserveIntelligenceBudget({
    budgetId: 'budget-1',
    userId: USER_A,
    reservationId: 'reservation-1',
    amountAtomic: '10000',
    idempotencyKey: 'idem-key-1',
    now: NOW,
    expiresAt: '2026-07-20T12:15:00.000Z',
  });

  const settled = await repository.settleIntelligenceReservation('reservation-1', USER_A, '2026-07-20T12:05:00.000Z');
  assert.equal(settled.reservation?.status, 'settled');
  assert.equal(settled.budget?.reservedAtomic, '0');
  assert.equal(settled.budget?.periodSpentAtomic, '10000');

  // Idempotent repeat: no double-application.
  const repeat = await repository.settleIntelligenceReservation('reservation-1', USER_A, '2026-07-20T12:06:00.000Z');
  assert.equal(repeat.budget?.periodSpentAtomic, '10000');
  assert.equal(repeat.budget?.reservedAtomic, '0');
});

test('releaseIntelligenceReservation: returns the amount to headroom WITHOUT touching period_spent, is idempotent', async () => {
  const { repository } = await seededRepository();
  await repository.reserveIntelligenceBudget({
    budgetId: 'budget-1',
    userId: USER_A,
    reservationId: 'reservation-1',
    amountAtomic: '10000',
    idempotencyKey: 'idem-key-1',
    now: NOW,
    expiresAt: '2026-07-20T12:15:00.000Z',
  });

  const released = await repository.releaseIntelligenceReservation(
    'reservation-1',
    USER_A,
    '2026-07-20T12:05:00.000Z',
    'provider_failed',
  );
  assert.equal(released.reservation?.status, 'released');
  assert.equal(released.budget?.reservedAtomic, '0');
  assert.equal(released.budget?.periodSpentAtomic, '0'); // user was NEVER charged

  const repeat = await repository.releaseIntelligenceReservation(
    'reservation-1',
    USER_A,
    '2026-07-20T12:06:00.000Z',
    'provider_failed',
  );
  assert.equal(repeat.budget?.reservedAtomic, '0');
});

test('settle/release on a missing or foreign-tenant reservation is a safe no-op (null, null)', async () => {
  const { repository } = await seededRepository();
  const missingSettle = await repository.settleIntelligenceReservation('does-not-exist', USER_A, NOW);
  assert.deepEqual(missingSettle, { reservation: null, budget: null });

  await repository.reserveIntelligenceBudget({
    budgetId: 'budget-1',
    userId: USER_A,
    reservationId: 'reservation-1',
    amountAtomic: '10000',
    idempotencyKey: 'idem-key-1',
    now: NOW,
    expiresAt: '2026-07-20T12:15:00.000Z',
  });
  const foreignRelease = await repository.releaseIntelligenceReservation('reservation-1', USER_B, NOW, 'x');
  assert.deepEqual(foreignRelease, { reservation: null, budget: null });
  // Untouched by the foreign-tenant attempt.
  const budget = await repository.getIntelligenceBudgetById('budget-1', USER_A);
  assert.equal(budget?.reservedAtomic, '10000');
});

// --- TTL / expireStaleIntelligenceReservations --------------------------------

test('expireStaleIntelligenceReservations: expires only reservations past their TTL and returns headroom', async () => {
  const { repository } = await seededRepository();
  await repository.reserveIntelligenceBudget({
    budgetId: 'budget-1',
    userId: USER_A,
    reservationId: 'reservation-stale',
    amountAtomic: '10000',
    idempotencyKey: 'idem-stale',
    now: NOW,
    expiresAt: '2026-07-20T12:05:00.000Z', // expires 5 min after NOW
  });
  await repository.reserveIntelligenceBudget({
    budgetId: 'budget-1',
    userId: USER_A,
    reservationId: 'reservation-fresh',
    amountAtomic: '20000',
    idempotencyKey: 'idem-fresh',
    now: NOW,
    expiresAt: '2026-07-20T13:00:00.000Z', // still valid at the check time below
  });

  const afterExpiry = await repository.expireStaleIntelligenceReservations('budget-1', '2026-07-20T12:10:00.000Z');
  assert.equal(afterExpiry?.reservedAtomic, '20000'); // only the fresh reservation's amount remains reserved

  const reservations = await repository.listIntelligenceBudgetReservations('budget-1', USER_A);
  const stale = reservations.find((entry) => entry.id === 'reservation-stale');
  const fresh = reservations.find((entry) => entry.id === 'reservation-fresh');
  assert.equal(stale?.status, 'expired');
  assert.equal(fresh?.status, 'reserved');
});

test('expireStaleIntelligenceReservations is lazy/idempotent: a second call after nothing new expired is a no-op', async () => {
  const { repository } = await seededRepository();
  await repository.reserveIntelligenceBudget({
    budgetId: 'budget-1',
    userId: USER_A,
    reservationId: 'reservation-stale',
    amountAtomic: '10000',
    idempotencyKey: 'idem-stale',
    now: NOW,
    expiresAt: '2026-07-20T12:05:00.000Z',
  });
  await repository.expireStaleIntelligenceReservations('budget-1', '2026-07-20T12:10:00.000Z');
  const second = await repository.expireStaleIntelligenceReservations('budget-1', '2026-07-20T12:20:00.000Z');
  assert.equal(second?.reservedAtomic, '0');
});

test('expireStaleIntelligenceReservations returns null for a missing budget', async () => {
  const repository = new InMemoryRouteStorageRepository();
  assert.equal(await repository.expireStaleIntelligenceReservations('missing-budget', NOW), null);
});

// --- tenant isolation ----------------------------------------------------------

test('listIntelligenceBudgetReservations hides reservations from another tenant', async () => {
  const { repository } = await seededRepository();
  await repository.reserveIntelligenceBudget({
    budgetId: 'budget-1',
    userId: USER_A,
    reservationId: 'reservation-1',
    amountAtomic: '10000',
    idempotencyKey: 'idem-key-1',
    now: NOW,
    expiresAt: '2026-07-20T12:15:00.000Z',
  });
  assert.deepEqual(await repository.listIntelligenceBudgetReservations('budget-1', USER_B), []);
});
