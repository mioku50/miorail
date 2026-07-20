import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryRouteStorageRepository } from '@mioagent/route-storage';
import { ZERO_HASH_V1 } from '@mioagent/route-domain';
import {
  hashIntelligenceBudgetV1,
  IntelligenceBudgetReservationV1Schema,
  IntelligenceBudgetV1Schema,
  IntelligenceCategoryV1Schema,
  intelligenceBudgetReservationV1FromRecord,
  intelligenceBudgetV1FromRecord,
  type IntelligenceBudgetV1,
} from '../src/budget-contracts.js';
import { budgetDomainFixture, insertBudgetFixture, TENANT_ID, WALLET_ADDRESS } from './fixtures.js';
import { USDC_BASE } from '@mioagent/route-domain/fixtures';

describe('IntelligenceCategoryV1Schema (T60 decision 2)', () => {
  it('is exactly the route-domain intelligence category enum, never an asset-movement kind', () => {
    assert.deepEqual(
      [...IntelligenceCategoryV1Schema.options].sort(),
      ['inference', 'liquidity', 'risk', 'route_quote', 'simulation'].sort(),
    );
    for (const forbidden of ['transfer', 'swap', 'deposit', 'borrow', 'withdraw', 'purchase', 'arbitrary_call']) {
      assert.equal(IntelligenceCategoryV1Schema.safeParse(forbidden).success, false);
    }
  });
});

describe('IntelligenceBudgetV1Schema', () => {
  it('accepts a well-formed budget with a matching hash', () => {
    const budget = budgetDomainFixture();
    assert.equal(budget.budgetHash, hashIntelligenceBudgetV1(budget));
    assert.equal(IntelligenceBudgetV1Schema.safeParse(budget).success, true);
  });

  it('rejects a tampered budgetHash', () => {
    const budget = { ...budgetDomainFixture(), budgetHash: ZERO_HASH_V1 };
    assert.equal(IntelligenceBudgetV1Schema.safeParse(budget).success, false);
  });

  it('rejects maxPerCallAtomic exceeding periodLimitAtomic', () => {
    const draft = { ...budgetDomainFixture(), maxPerCallAtomic: '2000000', budgetHash: ZERO_HASH_V1 };
    const withHash = { ...draft, budgetHash: hashIntelligenceBudgetV1(draft) };
    assert.equal(IntelligenceBudgetV1Schema.safeParse(withHash).success, false);
  });

  it('rejects duplicate allowedCategories', () => {
    const draft = {
      ...budgetDomainFixture(),
      allowedCategories: ['simulation', 'simulation'] as unknown as IntelligenceBudgetV1['allowedCategories'],
      budgetHash: ZERO_HASH_V1,
    };
    const withHash = { ...draft, budgetHash: hashIntelligenceBudgetV1(draft) };
    assert.equal(IntelligenceBudgetV1Schema.safeParse(withHash).success, false);
  });

  it('requires revokedAt when status is revoked, and forbids it otherwise', () => {
    const revokedWithoutTimestamp = { ...budgetDomainFixture(), status: 'revoked' as const, budgetHash: ZERO_HASH_V1 };
    const hashed1 = { ...revokedWithoutTimestamp, budgetHash: hashIntelligenceBudgetV1(revokedWithoutTimestamp) };
    assert.equal(IntelligenceBudgetV1Schema.safeParse(hashed1).success, false);

    const activeWithTimestamp = { ...budgetDomainFixture(), revokedAt: '2026-07-20T12:00:00.000Z', budgetHash: ZERO_HASH_V1 };
    const hashed2 = { ...activeWithTimestamp, budgetHash: hashIntelligenceBudgetV1(activeWithTimestamp) };
    assert.equal(IntelligenceBudgetV1Schema.safeParse(hashed2).success, false);
  });

  it('the budgetHash excludes lifecycle fields (status transitions never change it)', () => {
    const active = budgetDomainFixture({ status: 'active' });
    const paused = budgetDomainFixture({ status: 'paused' });
    assert.equal(active.budgetHash, paused.budgetHash);
  });
});

describe('IntelligenceBudgetReservationV1Schema', () => {
  it('rejects a non-positive amountAtomic', () => {
    const draft = {
      schemaVersion: 'intelligence-budget-reservation/v1' as const,
      id: 'reservation-1',
      tenantId: TENANT_ID,
      walletAddress: WALLET_ADDRESS,
      chainId: 8453 as const,
      createdAt: '2026-07-20T12:00:00.000Z',
      updatedAt: '2026-07-20T12:00:00.000Z',
      status: 'reserved' as const,
      budgetId: 'budget-1',
      asset: USDC_BASE,
      amountAtomic: '0',
      idempotencyKey: 'idem-1',
      expiresAt: '2026-07-20T12:15:00.000Z',
    };
    assert.equal(IntelligenceBudgetReservationV1Schema.safeParse(draft).success, false);
  });
});

describe('intelligenceBudgetV1FromRecord / intelligenceBudgetReservationV1FromRecord', () => {
  it('round-trips a route-storage IntelligenceBudgetRecord into a valid, hash-consistent domain object', async () => {
    const repository = new InMemoryRouteStorageRepository();
    const record = await insertBudgetFixture(repository);
    const domain = intelligenceBudgetV1FromRecord(record, USDC_BASE);
    assert.equal(domain.id, record.id);
    assert.equal(domain.tenantId, record.userId);
    assert.equal(domain.budgetHash, record.budgetHash);
    assert.equal(IntelligenceBudgetV1Schema.safeParse(domain).success, true);
  });

  it('round-trips an IntelligenceBudgetReservationRecord into a valid domain object', async () => {
    const repository = new InMemoryRouteStorageRepository();
    const record = await insertBudgetFixture(repository);
    const domain = intelligenceBudgetV1FromRecord(record, USDC_BASE);
    const reserveResult = await repository.reserveIntelligenceBudget({
      budgetId: record.id,
      userId: TENANT_ID,
      reservationId: 'reservation-1',
      amountAtomic: '10000',
      idempotencyKey: 'idem-1',
      now: '2026-07-20T12:00:00.000Z',
      expiresAt: '2026-07-20T12:15:00.000Z',
    });
    assert.equal(reserveResult.outcome, 'reserved');
    if (reserveResult.outcome !== 'reserved') throw new Error('unreachable');
    const reservationDomain = intelligenceBudgetReservationV1FromRecord(reserveResult.reservation, domain);
    assert.equal(IntelligenceBudgetReservationV1Schema.safeParse(reservationDomain).success, true);
    assert.equal(reservationDomain.budgetId, record.id);
    assert.equal(reservationDomain.walletAddress, domain.walletAddress);
  });
});
