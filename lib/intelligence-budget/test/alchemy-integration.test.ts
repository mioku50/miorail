import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ALCHEMY_SIMULATION_PROVIDER_ID_V1,
  createAlchemySimulationProviderV1,
} from '@mioagent/paid-intelligence';
import { runBudgetSimulationV1, type RunBudgetSimulationInputV1 } from '../src/coordinator.js';
import type {
  SpendPermissionChargeInputV1,
  SpendPermissionChargeResultV1,
  SpendPermissionCharger,
  SpendPermissionPreflightInputV1,
  SpendPermissionPreflightResultV1,
} from '../src/spendPermissionCharger.js';
import {
  BUDGET_BLUEPRINT_FIXTURE,
  SIMULATION_PRICE,
  TENANT_ID,
  WALLET_ADDRESS,
  seedBudgetSimulationFixture,
} from './fixtures.js';

// ---------------------------------------------------------------------------
// T63B §7/§10 — the T60 Intelligence Budget flow running ON the Alchemy
// adapter. Same reserve → simulate → evidence → Spend-Permission charge →
// settle sequence as before; only the provider behind the shared
// SimulationProvider seam changed. No unit test may touch the network.
// ---------------------------------------------------------------------------

globalThis.fetch = (() => {
  throw new Error('live network call attempted in a unit test');
}) as unknown as typeof fetch;

const NOW = new Date('2026-07-25T12:00:00.000Z');
const API_KEY = 'budget-integration-key';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function topicAddress(address: string): string {
  return `0x${'0'.repeat(24)}${address.slice(2)}`;
}

function alchemyFetch(calls: unknown[], counter?: { count: number; urls: string[] }): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (counter) {
      counter.count += 1;
      counter.urls.push(String(url));
    }
    const id = JSON.parse(String(init?.body)).id as string;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: [{ number: '0x2ed1f16', calls }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

function successCalls(count: number) {
  return Array.from({ length: count }, (_value, index) => ({
    status: '0x1',
    gasUsed: '0x5208',
    logs:
      index === 0
        ? [
            {
              address: USDC,
              topics: [
                TRANSFER_TOPIC,
                topicAddress('0x2222222222222222222222222222222222222222'),
                topicAddress(WALLET_ADDRESS),
              ],
              data: `0x${(750_000n).toString(16).padStart(64, '0')}`,
            },
          ]
        : [],
  }));
}

function mockCharger(): SpendPermissionCharger & { chargeCallCount: number; preflightCallCount: number } {
  const charger = {
    chargeCallCount: 0,
    preflightCallCount: 0,
    async preflight(_input: SpendPermissionPreflightInputV1): Promise<SpendPermissionPreflightResultV1> {
      charger.preflightCallCount += 1;
      return { ok: true };
    },
    async charge(_input: SpendPermissionChargeInputV1): Promise<SpendPermissionChargeResultV1> {
      charger.chargeCallCount += 1;
      return { ok: true, proof: { txHash: `0x${'a'.repeat(64)}` } };
    },
  };
  return charger;
}

function inputFor(routeRunId: string, blueprintId: string, requestId = 'req-alchemy-1'): RunBudgetSimulationInputV1 {
  return {
    tenantId: TENANT_ID,
    walletAddress: WALLET_ADDRESS,
    routeRunId,
    blueprintId,
    blueprintHash: BUDGET_BLUEPRINT_FIXTURE.blueprintHash,
    category: 'simulation',
    requestId,
  };
}

describe('T60 Intelligence Budget flow on the Alchemy adapter', () => {
  it('charges once through the Spend Permission and records Alchemy-backed evidence', async () => {
    const { repository, spendPermissionRepository, routeRunId, blueprintId } = await seedBudgetSimulationFixture();
    const counter = { count: 0, urls: [] as string[] };
    const charger = mockCharger();
    const callCount = BUDGET_BLUEPRINT_FIXTURE.calls.length;

    const result = await runBudgetSimulationV1(
      {
        repository,
        provider: createAlchemySimulationProviderV1({
          apiKey: API_KEY,
          fetchImpl: alchemyFetch(successCalls(callCount), counter),
        }),
        charger,
        spendPermissionRepository,
        now: () => NOW,
        price: SIMULATION_PRICE,
        providerId: ALCHEMY_SIMULATION_PROVIDER_ID_V1,
      },
      inputFor(routeRunId, blueprintId),
    );

    assert.equal(result.outcome, 'charged');
    if (result.outcome !== 'charged') throw new Error('unreachable');
    // Payment path is byte-for-byte the T60 one: one preflight, one charge.
    assert.equal(charger.preflightCallCount, 1);
    assert.equal(charger.chargeCallCount, 1);
    assert.equal(result.charge.status, 'settled');
    assert.equal(result.charge.fundingMode, 'spend_permission');
    assert.equal(result.reservation.status, 'settled');
    assert.equal(result.budget.periodSpentAtomic, '10000');
    assert.equal(result.budget.reservedAtomic, '0');

    // Evidence is bound to the Alchemy provider, the chain, and the block.
    assert.equal(result.evidence.provider.id, ALCHEMY_SIMULATION_PROVIDER_ID_V1);
    assert.equal(result.evidence.chainId, 8453);
    assert.equal(result.evidence.blockNumber, String(0x2ed1f16));
    assert.equal(result.evidence.freeOrPaid, 'paid');
    assert.deepEqual(result.evidence.validationErrors, []);

    assert.equal(result.response?.gasUsed, String(0x5208 * callCount));
    assert.equal(result.response?.assetChanges?.status, 'available');
    assert.equal(result.response?.assetChanges?.changes[0].amountAtomic, '750000');

    // Exactly one upstream simulation, and the key never left the endpoint.
    assert.equal(counter.count, 1);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(API_KEY));
  });

  it('an Alchemy failure releases the reservation and NEVER charges the user', async () => {
    const { repository, spendPermissionRepository, routeRunId, blueprintId, permission } =
      await seedBudgetSimulationFixture();
    const charger = mockCharger();

    const result = await runBudgetSimulationV1(
      {
        repository,
        provider: createAlchemySimulationProviderV1({
          apiKey: API_KEY,
          fetchImpl: (async () => {
            throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
          }) as unknown as typeof fetch,
        }),
        charger,
        spendPermissionRepository,
        now: () => NOW,
        price: SIMULATION_PRICE,
        providerId: ALCHEMY_SIMULATION_PROVIDER_ID_V1,
      },
      inputFor(routeRunId, blueprintId, 'req-alchemy-timeout'),
    );

    assert.equal(result.outcome, 'provider_failed');
    if (result.outcome !== 'provider_failed') throw new Error('unreachable');
    assert.equal(result.reason, 'provider_timeout');
    assert.equal(charger.chargeCallCount, 0, 'a provider failure must never charge');

    const updatedPermission = await spendPermissionRepository.getById(permission.id);
    assert.equal(updatedPermission?.spent, 0, 'nothing is spent when no service was delivered');
  });

  it('an unknown call status fails closed rather than being charged as a passed simulation', async () => {
    const { repository, spendPermissionRepository, routeRunId, blueprintId } = await seedBudgetSimulationFixture();
    const charger = mockCharger();
    const callCount = BUDGET_BLUEPRINT_FIXTURE.calls.length;
    const calls = successCalls(callCount).map((call, index) => (index === 0 ? { ...call, status: '0x7' } : call));

    const result = await runBudgetSimulationV1(
      {
        repository,
        provider: createAlchemySimulationProviderV1({ apiKey: API_KEY, fetchImpl: alchemyFetch(calls) }),
        charger,
        spendPermissionRepository,
        now: () => NOW,
        price: SIMULATION_PRICE,
        providerId: ALCHEMY_SIMULATION_PROVIDER_ID_V1,
      },
      inputFor(routeRunId, blueprintId, 'req-alchemy-unknown-status'),
    );

    assert.equal(result.outcome, 'provider_failed');
    if (result.outcome !== 'provider_failed') throw new Error('unreachable');
    assert.equal(result.reason, 'provider_invalid_schema');
    assert.equal(charger.chargeCallCount, 0);
  });
});
