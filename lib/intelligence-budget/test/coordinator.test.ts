import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { runBudgetSimulationV1, type RunBudgetSimulationInputV1 } from '../src/coordinator.js';
import type {
  SpendPermissionChargeInputV1,
  SpendPermissionChargeResultV1,
  SpendPermissionCharger,
  SpendPermissionPreflightInputV1,
  SpendPermissionPreflightResultV1,
} from '../src/spendPermissionCharger.js';
import type { SimulationProvider, SimulationProviderResultV1 } from '@mioagent/paid-intelligence';
import {
  BUDGET_BLUEPRINT_FIXTURE,
  SIMULATION_PRICE,
  SIMULATION_PROVIDER_REF,
  TENANT_ID,
  WALLET_ADDRESS,
  seedBudgetSimulationFixture,
} from './fixtures.js';

const NOW = new Date('2026-07-20T12:00:00.000Z');

const SUCCESS_BODY = {
  status: 'success' as const,
  blockNumber: 33_555_111,
  gasUsed: '145000',
  stateChanges: [{ address: WALLET_ADDRESS, kind: 'balance' as const, summary: 'USDC balance decreases' }],
  revertReason: null,
};

function mockProvider(
  result: SimulationProviderResultV1 | ((request: unknown) => SimulationProviderResultV1),
): SimulationProvider & { callCount: number; lastRequest: unknown } {
  const provider = {
    providerId: SIMULATION_PROVIDER_REF.id,
    callCount: 0,
    lastRequest: undefined as unknown,
    async simulate(request: unknown): Promise<SimulationProviderResultV1> {
      provider.callCount += 1;
      provider.lastRequest = request;
      return typeof result === 'function' ? result(request) : result;
    },
  };
  return provider;
}

function mockCharger(options: {
  preflight?: SpendPermissionPreflightResultV1 | ((input: SpendPermissionPreflightInputV1) => SpendPermissionPreflightResultV1);
  charge?: SpendPermissionChargeResultV1 | ((input: SpendPermissionChargeInputV1) => SpendPermissionChargeResultV1);
} = {}): SpendPermissionCharger & {
  chargeCallCount: number;
  preflightCallCount: number;
  lastChargeInput: SpendPermissionChargeInputV1 | undefined;
} {
  const preflightResult = options.preflight ?? { ok: true };
  const chargeResult = options.charge ?? { ok: true, proof: { txHash: `0x${'a'.repeat(64)}` } };
  const charger = {
    chargeCallCount: 0,
    preflightCallCount: 0,
    lastChargeInput: undefined as SpendPermissionChargeInputV1 | undefined,
    async preflight(input: SpendPermissionPreflightInputV1): Promise<SpendPermissionPreflightResultV1> {
      charger.preflightCallCount += 1;
      return typeof preflightResult === 'function' ? preflightResult(input) : preflightResult;
    },
    async charge(input: SpendPermissionChargeInputV1): Promise<SpendPermissionChargeResultV1> {
      charger.chargeCallCount += 1;
      charger.lastChargeInput = input;
      return typeof chargeResult === 'function' ? chargeResult(input) : chargeResult;
    },
  };
  return charger;
}

function inputFor(routeRunId: string, blueprintId: string, overrides: Partial<RunBudgetSimulationInputV1> = {}): RunBudgetSimulationInputV1 {
  return {
    tenantId: TENANT_ID,
    walletAddress: WALLET_ADDRESS,
    routeRunId,
    blueprintId,
    blueprintHash: BUDGET_BLUEPRINT_FIXTURE.blueprintHash,
    category: 'simulation',
    requestId: 'req-1',
    ...overrides,
  };
}

describe('runBudgetSimulationV1', () => {
  it('happy path: valid budget + provider success + charge success -> charged, settled, spent recorded once', async () => {
    const { repository, spendPermissionRepository, routeRunId, blueprintId, permission } = await seedBudgetSimulationFixture();
    const provider = mockProvider({ ok: true, body: SUCCESS_BODY });
    const charger = mockCharger();

    const result = await runBudgetSimulationV1(
      { repository, provider, charger, spendPermissionRepository, now: () => NOW, price: SIMULATION_PRICE, providerId: SIMULATION_PROVIDER_REF.id },
      inputFor(routeRunId, blueprintId),
    );

    assert.equal(result.outcome, 'charged');
    if (result.outcome !== 'charged') throw new Error('unreachable');
    assert.equal(result.charge.status, 'settled');
    assert.equal(result.charge.fundingMode, 'spend_permission');
    assert.equal(result.charge.spendPermissionId, permission.id);
    assert.equal(result.charge.intelligenceBudgetId, result.budget.id);
    assert.equal(result.charge.reservationId, result.reservation.id);
    assert.equal(result.charge.chargedCost?.amountAtomic, '10000');

    assert.equal(result.evidence.freeOrPaid, 'paid');
    assert.equal(result.evidence.intelligenceChargeId, result.charge.id);
    assert.equal(result.evidence.evidenceType, 'simulation');

    assert.equal(result.reservation.status, 'settled');
    assert.equal(result.budget.periodSpentAtomic, '10000');
    assert.equal(result.budget.reservedAtomic, '0');

    assert.equal(charger.chargeCallCount, 1);
    assert.equal(charger.preflightCallCount, 1);
    assert.equal(provider.callCount, 1);

    const updatedPermission = await spendPermissionRepository.getById(permission.id);
    assert.ok(updatedPermission);
    assert.equal(updatedPermission?.spent, 0.01);

    // Provider only ever sees the whitelisted fields.
    const request = provider.lastRequest as { chainId: number; walletAddress: string };
    assert.equal(request.chainId, 8453);
    assert.equal(request.walletAddress, WALLET_ADDRESS);
  });

  it('blocks when there is no active budget for this wallet', async () => {
    const { repository, spendPermissionRepository, routeRunId, blueprintId } = await seedBudgetSimulationFixture();
    const provider = mockProvider({ ok: true, body: SUCCESS_BODY });
    const charger = mockCharger();

    const result = await runBudgetSimulationV1(
      { repository, provider, charger, spendPermissionRepository, now: () => NOW, price: SIMULATION_PRICE, providerId: SIMULATION_PROVIDER_REF.id },
      inputFor(routeRunId, blueprintId, { walletAddress: '0x2222222222222222222222222222222222222222' }),
    );

    assert.equal(result.outcome, 'blocked');
    assert.equal(provider.callCount, 0);
    assert.equal(charger.chargeCallCount, 0);
  });

  it('blocks when the requested category is outside allowedCategories, without ever calling the provider', async () => {
    const { repository, spendPermissionRepository, routeRunId, blueprintId } = await seedBudgetSimulationFixture({
      budget: { allowedCategories: ['route_quote'] },
    });
    const provider = mockProvider({ ok: true, body: SUCCESS_BODY });
    const charger = mockCharger();

    const result = await runBudgetSimulationV1(
      { repository, provider, charger, spendPermissionRepository, now: () => NOW, price: SIMULATION_PRICE, providerId: SIMULATION_PROVIDER_REF.id },
      inputFor(routeRunId, blueprintId),
    );

    assert.equal(result.outcome, 'blocked');
    if (result.outcome !== 'blocked') throw new Error('unreachable');
    assert.equal(result.reason, 'category_not_allowed');
    assert.equal(provider.callCount, 0);
  });

  it('limit_exceeded when the price exceeds the per-call maximum, without reserving anything', async () => {
    const { repository, spendPermissionRepository, routeRunId, blueprintId, budget } = await seedBudgetSimulationFixture({
      budget: { maxPerCallAtomic: '5000' }, // price is 10000
    });
    const provider = mockProvider({ ok: true, body: SUCCESS_BODY });
    const charger = mockCharger();

    const result = await runBudgetSimulationV1(
      { repository, provider, charger, spendPermissionRepository, now: () => NOW, price: SIMULATION_PRICE, providerId: SIMULATION_PROVIDER_REF.id },
      inputFor(routeRunId, blueprintId),
    );

    assert.equal(result.outcome, 'limit_exceeded');
    assert.equal(provider.callCount, 0);
    const reservations = await repository.listIntelligenceBudgetReservations(budget.id, TENANT_ID);
    assert.equal(reservations.length, 0);
  });

  it('limit_exceeded once periodSpent + reserved + cost would exceed the monthly limit', async () => {
    const { repository, spendPermissionRepository, routeRunId, blueprintId } = await seedBudgetSimulationFixture({
      budget: { periodLimitAtomic: '10000', maxPerCallAtomic: '10000' }, // room for exactly one call
    });
    const provider = mockProvider({ ok: true, body: SUCCESS_BODY });
    const charger = mockCharger();
    const deps = { repository, provider, charger, spendPermissionRepository, now: () => NOW, price: SIMULATION_PRICE, providerId: SIMULATION_PROVIDER_REF.id };

    const first = await runBudgetSimulationV1(deps, inputFor(routeRunId, blueprintId, { requestId: 'req-a' }));
    assert.equal(first.outcome, 'charged');

    const second = await runBudgetSimulationV1(deps, inputFor(routeRunId, blueprintId, { requestId: 'req-b' }));
    assert.equal(second.outcome, 'limit_exceeded');
    assert.equal(provider.callCount, 1); // second attempt never reached the provider
  });

  it('concurrent reservations never exceed the monthly limit: a second in-flight request sees limit_exceeded, not double-reserved', async () => {
    const { repository, spendPermissionRepository, routeRunId, blueprintId, budget } = await seedBudgetSimulationFixture({
      budget: { periodLimitAtomic: '10000', maxPerCallAtomic: '10000' },
    });
    // Simulate a concurrent in-flight request that already holds the reservation.
    const concurrentReserve = await repository.reserveIntelligenceBudget({
      budgetId: budget.id,
      userId: TENANT_ID,
      reservationId: 'reservation-concurrent',
      amountAtomic: '10000',
      idempotencyKey: 'concurrent-key',
      now: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 900_000).toISOString(),
    });
    assert.equal(concurrentReserve.outcome, 'reserved');

    const provider = mockProvider({ ok: true, body: SUCCESS_BODY });
    const charger = mockCharger();
    const result = await runBudgetSimulationV1(
      { repository, provider, charger, spendPermissionRepository, now: () => NOW, price: SIMULATION_PRICE, providerId: SIMULATION_PROVIDER_REF.id },
      inputFor(routeRunId, blueprintId, { requestId: 'req-second' }),
    );

    assert.equal(result.outcome, 'limit_exceeded');
    assert.equal(provider.callCount, 0);
    const finalBudget = await repository.getIntelligenceBudgetById(budget.id, TENANT_ID);
    assert.equal(finalBudget?.reservedAtomic, '10000'); // only the concurrent reservation, never doubled
  });

  it('idempotent replay: the SAME requestId returns the cached charge, never re-calls the provider or the charger', async () => {
    const { repository, spendPermissionRepository, routeRunId, blueprintId } = await seedBudgetSimulationFixture();
    const provider = mockProvider({ ok: true, body: SUCCESS_BODY });
    const charger = mockCharger();
    const deps = { repository, provider, charger, spendPermissionRepository, now: () => NOW, price: SIMULATION_PRICE, providerId: SIMULATION_PROVIDER_REF.id };

    const first = await runBudgetSimulationV1(deps, inputFor(routeRunId, blueprintId, { requestId: 'req-idem' }));
    assert.equal(first.outcome, 'charged');
    if (first.outcome !== 'charged') throw new Error('unreachable');

    const second = await runBudgetSimulationV1(deps, inputFor(routeRunId, blueprintId, { requestId: 'req-idem' }));
    assert.equal(second.outcome, 'charged');
    if (second.outcome !== 'charged') throw new Error('unreachable');
    assert.equal(second.charge.id, first.charge.id);

    assert.equal(provider.callCount, 1);
    assert.equal(charger.chargeCallCount, 1);

    const charges = await repository.listIntelligenceCharges(routeRunId, TENANT_ID);
    assert.equal(charges.length, 1);
  });

  it('provider failure: the user is NEVER charged, the reservation is released, charge ends released', async () => {
    const { repository, spendPermissionRepository, routeRunId, blueprintId, budget, permission } = await seedBudgetSimulationFixture();
    const provider = mockProvider({ ok: false, errorCode: 'timeout', detail: 'timed out' });
    const charger = mockCharger();

    const result = await runBudgetSimulationV1(
      { repository, provider, charger, spendPermissionRepository, now: () => NOW, price: SIMULATION_PRICE, providerId: SIMULATION_PROVIDER_REF.id },
      inputFor(routeRunId, blueprintId),
    );

    assert.equal(result.outcome, 'provider_failed');
    if (result.outcome !== 'provider_failed') throw new Error('unreachable');
    assert.equal(result.charge.status, 'released');
    assert.equal(charger.chargeCallCount, 0); // never even attempted

    const reservations = await repository.listIntelligenceBudgetReservations(budget.id, TENANT_ID);
    assert.equal(reservations.length, 1);
    assert.equal(reservations[0]?.status, 'released');

    const finalBudget = await repository.getIntelligenceBudgetById(budget.id, TENANT_ID);
    assert.equal(finalBudget?.reservedAtomic, '0');
    assert.equal(finalBudget?.periodSpentAtomic, '0');

    const finalPermission = await spendPermissionRepository.getById(permission.id);
    assert.equal(finalPermission?.spent, 0); // untouched
  });

  it('an invalid/malformed provider response is also a provider_failed release, never a charge', async () => {
    const { repository, spendPermissionRepository, routeRunId, blueprintId } = await seedBudgetSimulationFixture();
    const provider = mockProvider({ ok: true, body: { status: 'success', blockNumber: 0 } });
    const charger = mockCharger();

    const result = await runBudgetSimulationV1(
      { repository, provider, charger, spendPermissionRepository, now: () => NOW, price: SIMULATION_PRICE, providerId: SIMULATION_PROVIDER_REF.id },
      inputFor(routeRunId, blueprintId),
    );

    assert.equal(result.outcome, 'provider_failed');
    assert.equal(charger.chargeCallCount, 0);
  });

  it('successful service + failed charge -> reconciliation_required, budget paused, reservation stays reserved, never repeated', async () => {
    const { repository, spendPermissionRepository, routeRunId, blueprintId, budget, permission } = await seedBudgetSimulationFixture();
    const provider = mockProvider({ ok: true, body: SUCCESS_BODY });
    const charger = mockCharger({ charge: { ok: false, reason: 'onchain_charge_failed' } });

    const result = await runBudgetSimulationV1(
      { repository, provider, charger, spendPermissionRepository, now: () => NOW, price: SIMULATION_PRICE, providerId: SIMULATION_PROVIDER_REF.id },
      inputFor(routeRunId, blueprintId, { requestId: 'req-recon' }),
    );

    assert.equal(result.outcome, 'reconciliation_required');
    if (result.outcome !== 'reconciliation_required') throw new Error('unreachable');
    assert.equal(result.charge.status, 'reconciliation_required');
    assert.equal(result.budget.status, 'paused');
    assert.equal(charger.chargeCallCount, 1);

    const reservations = await repository.listIntelligenceBudgetReservations(budget.id, TENANT_ID);
    assert.equal(reservations.length, 1);
    assert.equal(reservations[0]?.status, 'reserved'); // obligation stays open, never released

    const finalPermission = await spendPermissionRepository.getById(permission.id);
    assert.equal(finalPermission?.spent, 0); // charge failed -> never incremented

    // A fresh attempt on the now-paused budget is blocked, and the charge is
    // never automatically re-attempted.
    const retry = await runBudgetSimulationV1(
      { repository, provider, charger, spendPermissionRepository, now: () => NOW, price: SIMULATION_PRICE, providerId: SIMULATION_PROVIDER_REF.id },
      inputFor(routeRunId, blueprintId, { requestId: 'req-recon-2' }),
    );
    assert.equal(retry.outcome, 'blocked');
    assert.equal(charger.chargeCallCount, 1); // still 1 — no repeat charge
  });

  it('an expired Spend Permission blocks before any reservation is made', async () => {
    const { repository, spendPermissionRepository, routeRunId, blueprintId, budget } = await seedBudgetSimulationFixture({
      permission: { expiresAt: Date.parse('2026-01-01T00:00:00.000Z') },
    });
    const provider = mockProvider({ ok: true, body: SUCCESS_BODY });
    const charger = mockCharger();

    const result = await runBudgetSimulationV1(
      { repository, provider, charger, spendPermissionRepository, now: () => NOW, price: SIMULATION_PRICE, providerId: SIMULATION_PROVIDER_REF.id },
      inputFor(routeRunId, blueprintId),
    );

    assert.equal(result.outcome, 'blocked');
    assert.equal(provider.callCount, 0);
    const finalBudget = await repository.getIntelligenceBudgetById(budget.id, TENANT_ID);
    assert.equal(finalBudget?.reservedAtomic, '0');
  });

  it('an inactive Spend Permission blocks before any reservation is made', async () => {
    const { repository, spendPermissionRepository, routeRunId, blueprintId, budget } = await seedBudgetSimulationFixture({
      permission: { isActive: false },
    });
    const provider = mockProvider({ ok: true, body: SUCCESS_BODY });
    const charger = mockCharger();

    const result = await runBudgetSimulationV1(
      { repository, provider, charger, spendPermissionRepository, now: () => NOW, price: SIMULATION_PRICE, providerId: SIMULATION_PROVIDER_REF.id },
      inputFor(routeRunId, blueprintId),
    );

    assert.equal(result.outcome, 'blocked');
    assert.equal(provider.callCount, 0);
    const finalBudget = await repository.getIntelligenceBudgetById(budget.id, TENANT_ID);
    assert.equal(finalBudget?.reservedAtomic, '0');
  });

  it('a charger preflight rejection blocks before any reservation is made', async () => {
    const { repository, spendPermissionRepository, routeRunId, blueprintId, budget } = await seedBudgetSimulationFixture();
    const provider = mockProvider({ ok: true, body: SUCCESS_BODY });
    const charger = mockCharger({ preflight: { ok: false, reason: 'subscription_owner_mismatch' } });

    const result = await runBudgetSimulationV1(
      { repository, provider, charger, spendPermissionRepository, now: () => NOW, price: SIMULATION_PRICE, providerId: SIMULATION_PROVIDER_REF.id },
      inputFor(routeRunId, blueprintId),
    );

    assert.equal(result.outcome, 'blocked');
    if (result.outcome !== 'blocked') throw new Error('unreachable');
    assert.equal(result.reason, 'subscription_owner_mismatch');
    assert.equal(provider.callCount, 0);
    const finalBudget = await repository.getIntelligenceBudgetById(budget.id, TENANT_ID);
    assert.equal(finalBudget?.reservedAtomic, '0');
  });

  it('a revoked budget is invisible to getActiveIntelligenceBudget -> the auto-flow is blocked', async () => {
    const { repository, spendPermissionRepository, routeRunId, blueprintId, budget } = await seedBudgetSimulationFixture();
    await repository.updateIntelligenceBudget(budget.id, TENANT_ID, {
      status: 'revoked',
      revokedAt: NOW.toISOString(),
      budgetHash: budget.budgetHash,
      now: NOW.toISOString(),
    });
    const provider = mockProvider({ ok: true, body: SUCCESS_BODY });
    const charger = mockCharger();

    const result = await runBudgetSimulationV1(
      { repository, provider, charger, spendPermissionRepository, now: () => NOW, price: SIMULATION_PRICE, providerId: SIMULATION_PROVIDER_REF.id },
      inputFor(routeRunId, blueprintId),
    );

    assert.equal(result.outcome, 'blocked');
    assert.equal(provider.callCount, 0);
  });

  it('the same Spend Permission proof is never double-applied even across two independently charged calls', async () => {
    const fixedProof = { txHash: `0x${'f'.repeat(64)}` };
    const { repository, spendPermissionRepository, routeRunId, blueprintId, permission } = await seedBudgetSimulationFixture({
      budget: { periodLimitAtomic: '1000000', maxPerCallAtomic: '100000' },
    });
    const provider = mockProvider({ ok: true, body: SUCCESS_BODY });
    const charger = mockCharger({ charge: { ok: true, proof: fixedProof } });
    const deps = { repository, provider, charger, spendPermissionRepository, now: () => NOW, price: SIMULATION_PRICE, providerId: SIMULATION_PROVIDER_REF.id };

    const first = await runBudgetSimulationV1(deps, inputFor(routeRunId, blueprintId, { requestId: 'req-proof-a' }));
    assert.equal(first.outcome, 'charged');
    const afterFirst = await spendPermissionRepository.getById(permission.id);
    assert.equal(afterFirst?.spent, 0.01);

    // A second, logically-different request (new idempotencyKey — NOT a
    // cached replay) whose underlying charger happens to return the exact
    // same settlement proof a second time. incrementSpent's own idempotency
    // ledger (keyed by proof) must absorb this without double-counting.
    const second = await runBudgetSimulationV1(deps, inputFor(routeRunId, blueprintId, { requestId: 'req-proof-b' }));
    assert.equal(second.outcome, 'charged');
    assert.equal(charger.chargeCallCount, 2); // the charger WAS called twice...
    const afterSecond = await spendPermissionRepository.getById(permission.id);
    assert.equal(afterSecond?.spent, 0.01); // ...but spent only ever recorded once
  });

  it('never touches blueprint.calls as a transaction to send, and never sends a charger recipient/calls field (structural guard)', () => {
    const coordinatorPath = fileURLToPath(new URL('../src/coordinator.ts', import.meta.url));
    const source = readFileSync(coordinatorPath, 'utf8');

    // No live signing/sending vocabulary anywhere in this file.
    for (const forbidden of ['sendTransaction', 'writeContract', 'send_calls', 'signTransaction', 'walletClient', 'eth_sendTransaction', 'signTypedData']) {
      assert.ok(!source.includes(forbidden), `coordinator.ts must never reference ${forbidden}`);
    }
    // blueprint.calls is only ever (a) hash-integrity-checked
    // (hashApprovedCallsV1(blueprint.calls) — step 1's changed_calls guard)
    // or (b) handed to the simulation provider for a read-only simulate call
    // — never anywhere that builds/signs/sends a transaction. (?!Hash)
    // excludes the unrelated "blueprint.calls" PREFIX inside
    // "blueprint.callsHash" substring matches.
    const callsUsages = source.match(/blueprint\.calls(?!Hash)/g) ?? [];
    assert.equal(callsUsages.length, 2);
    assert.match(source, /hashApprovedCallsV1\(blueprint\.calls\)/);
    assert.match(source, /calls:\s*blueprint\.calls/);

    // The charger is only ever given permissionId/amountAtomic/idempotencyKey
    // — never a recipient or calls (those are the real implementation's own
    // closed-over server config, decision 7).
    const chargeCallMatch = source.match(/deps\.charger\.charge\(\{([\s\S]*?)\}\)/);
    assert.ok(chargeCallMatch);
    const chargeCallArgs = chargeCallMatch![1]!;
    assert.doesNotMatch(chargeCallArgs, /recipient/);
    assert.doesNotMatch(chargeCallArgs, /calls/);
    assert.match(chargeCallArgs, /permissionId/);
    assert.match(chargeCallArgs, /amountAtomic/);
  });

  it('the SpendPermissionCharger interface never accepts a recipient/calls input (source-level guard)', () => {
    const chargerPath = fileURLToPath(new URL('../src/spendPermissionCharger.ts', import.meta.url));
    const source = readFileSync(chargerPath, 'utf8');
    // Match actual import/require statements only — this file's own header
    // comment explains (in prose) that it never imports these packages,
    // which would otherwise false-positive a bare substring search.
    for (const forbidden of ['@base-org/account', '@coinbase/cdp-sdk', 'viem', 'wagmi', 'react']) {
      const escaped = forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const importPattern = new RegExp(`(?:from\\s+|require\\()['"]${escaped}(?:/|['"])`);
      assert.ok(!importPattern.test(source), `spendPermissionCharger.ts must never import ${forbidden}`);
    }
  });
});
