import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hashApprovedCallsV1 } from '@mioagent/route-domain';
import {
  ALCHEMY_SIMULATION_PROVIDER_ID_V1,
  createAlchemySimulationProviderV1,
} from '../src/providers/alchemy.js';
import { createSimulationProviderFromConfigV1, isKnownSimulationProviderIdV1 } from '../src/registry.js';
import { resolveSimulationProviderConfigV1 } from '../src/provider.js';
import { runPaidSimulationV1, type PaidSimulationSettlementV1 } from '../src/coordinator.js';
import { buildPendingSimulationChargeV1 } from '../src/charges.js';
import {
  SIMULATION_PRICE,
  SIMULATION_PROVIDER_REF,
  T59_BLUEPRINT_FIXTURE,
  WALLET_ADDRESS,
  seedPaidSimulationFixture,
} from './fixtures.js';

// ---------------------------------------------------------------------------
// T63B §7/§10 — the registry and the T59 one-time x402 flow running ON the
// Alchemy adapter. The point of these cases is that NOTHING about payment
// changes: the same coordinator, the same charge state machine, the same
// single settlement — only the provider behind the seam is different.
// ---------------------------------------------------------------------------

globalThis.fetch = (() => {
  throw new Error('live network call attempted in a unit test');
}) as unknown as typeof fetch;

const NOW = new Date('2026-07-25T12:00:00.000Z');
const API_KEY = 'integration-key';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function topicAddress(address: string): string {
  return `0x${'0'.repeat(24)}${address.slice(2)}`;
}

function alchemyFetch(calls: unknown[], counter?: { count: number }): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    if (counter) counter.count += 1;
    const id = JSON.parse(String(init?.body)).id as string;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: [{ number: '0x2ed1f16', calls }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const SUCCESS_CALLS = [
  {
    status: '0x1',
    gasUsed: '0x11170',
    logs: [
      {
        address: USDC,
        topics: [TRANSFER_TOPIC, topicAddress('0x2222222222222222222222222222222222222222'), topicAddress(WALLET_ADDRESS)],
        data: `0x${(2_000_000n).toString(16).padStart(64, '0')}`,
      },
    ],
  },
  { status: '0x1', gasUsed: '0x5208', logs: [] },
];

function settlement(txHash = `0x${'a'.repeat(64)}`): PaidSimulationSettlementV1 {
  return { txHash, payer: WALLET_ADDRESS, network: 'eip155:8453', amount: '10000', status: 'settled' };
}

function pendingCharge(routeRunId: string, blueprintId: string, idempotencyKey = 'idem-alchemy-1') {
  return buildPendingSimulationChargeV1({
    routeRunId,
    blueprintId,
    tenantId: T59_BLUEPRINT_FIXTURE.tenantId,
    walletAddress: WALLET_ADDRESS,
    intentHash: T59_BLUEPRINT_FIXTURE.intentHash,
    candidateHash: T59_BLUEPRINT_FIXTURE.selectedCandidateHash,
    idempotencyKey,
    price: SIMULATION_PRICE,
    provider: { ...SIMULATION_PROVIDER_REF, id: ALCHEMY_SIMULATION_PROVIDER_ID_V1 },
    now: NOW.toISOString(),
  });
}

describe('T63B provider registry', () => {
  it('knows exactly the two server-configured providers and nothing else', () => {
    assert.equal(isKnownSimulationProviderIdV1('generic-sim-v1'), true);
    assert.equal(isKnownSimulationProviderIdV1('alchemy-eth-simulate-v1'), true);
    assert.equal(isKnownSimulationProviderIdV1('tenderly-sim'), false);
  });

  it('builds the Alchemy adapter from env, and the generic provider stays untouched', () => {
    const alchemyEnv = {
      MIORAIL_SIMULATION_PROVIDER_ID: ALCHEMY_SIMULATION_PROVIDER_ID_V1,
      ALCHEMY_BASE_API_KEY: API_KEY,
    } as NodeJS.ProcessEnv;
    const alchemyConfig = resolveSimulationProviderConfigV1(alchemyEnv);
    assert.equal(alchemyConfig.configured, true);
    assert.equal(alchemyConfig.kind, 'alchemy_rpc');
    // The key is NEVER written into the config object that routes pass around.
    assert.doesNotMatch(JSON.stringify(alchemyConfig), new RegExp(API_KEY));
    assert.equal(alchemyConfig.url, undefined);
    assert.equal(createSimulationProviderFromConfigV1(alchemyConfig, { env: alchemyEnv })?.providerId, ALCHEMY_SIMULATION_PROVIDER_ID_V1);

    const genericEnv = {
      MIORAIL_SIMULATION_PROVIDER_ID: 'generic-sim-v1',
      MIORAIL_SIMULATION_PROVIDER_URL: 'https://sim.example.test/simulate',
      MIORAIL_SIMULATION_PROVIDER_ALLOWLIST: 'sim.example.test',
    } as NodeJS.ProcessEnv;
    const genericConfig = resolveSimulationProviderConfigV1(genericEnv);
    assert.equal(genericConfig.configured, true);
    assert.equal(genericConfig.url, 'https://sim.example.test/simulate');
    assert.equal(createSimulationProviderFromConfigV1(genericConfig, { env: genericEnv })?.providerId, 'generic-sim-v1');
  });

  it('fails closed on an unknown provider id and on a missing Alchemy key', () => {
    const unknown = resolveSimulationProviderConfigV1({ MIORAIL_SIMULATION_PROVIDER_ID: 'tenderly-sim' } as NodeJS.ProcessEnv);
    assert.equal(unknown.configured, false);
    assert.equal(unknown.missingReason, 'unknown_provider');
    assert.equal(createSimulationProviderFromConfigV1(unknown), null);

    const keyless = resolveSimulationProviderConfigV1({
      MIORAIL_SIMULATION_PROVIDER_ID: ALCHEMY_SIMULATION_PROVIDER_ID_V1,
    } as NodeJS.ProcessEnv);
    assert.equal(keyless.configured, false);
    assert.equal(keyless.missingReason, 'missing_api_key');
    assert.equal(createSimulationProviderFromConfigV1(keyless), null);
  });

  it('never falls back from one provider to another', () => {
    // An Alchemy selection with a generic URL configured must NOT quietly use
    // the generic endpoint — money would buy a different service than quoted.
    const config = resolveSimulationProviderConfigV1({
      MIORAIL_SIMULATION_PROVIDER_ID: ALCHEMY_SIMULATION_PROVIDER_ID_V1,
      MIORAIL_SIMULATION_PROVIDER_URL: 'https://sim.example.test/simulate',
      MIORAIL_SIMULATION_PROVIDER_ALLOWLIST: 'sim.example.test',
    } as NodeJS.ProcessEnv);
    assert.equal(config.configured, false);
    assert.equal(config.missingReason, 'missing_api_key');
    assert.equal(createSimulationProviderFromConfigV1(config), null);
  });
});

describe('T59 one-time x402 flow on the Alchemy adapter', () => {
  it('settles once, delivers paid evidence, and binds gas + proven asset changes to the responseHash', async () => {
    const { repository, routeRunId, blueprintId } = await seedPaidSimulationFixture();
    const charge = pendingCharge(routeRunId, blueprintId);
    await repository.insertIntelligenceCharge(routeRunId, charge);
    const counter = { count: 0 };

    const result = await runPaidSimulationV1(
      {
        repository,
        provider: createAlchemySimulationProviderV1({ apiKey: API_KEY, fetchImpl: alchemyFetch(SUCCESS_CALLS, counter) }),
        now: () => NOW,
        price: SIMULATION_PRICE,
        chargeProvider: { ...SIMULATION_PROVIDER_REF, id: ALCHEMY_SIMULATION_PROVIDER_ID_V1 },
      },
      {
        tenantId: charge.tenantId,
        walletAddress: WALLET_ADDRESS,
        routeRunId,
        blueprintId,
        settlement: settlement(),
        existingCharge: charge,
      },
    );

    assert.equal(result.outcome, 'simulated');
    if (result.outcome !== 'simulated') throw new Error('unreachable');
    // Payment architecture is untouched: one settlement, one delivered charge.
    assert.equal(result.charge.paymentState, 'settled');
    assert.equal(result.charge.serviceState, 'delivered');
    assert.equal(counter.count, 1);

    // Simulation state carries the block and both hashes.
    assert.equal(result.simulation.status, 'passed');
    assert.equal(result.simulation.blockNumber, String(0x2ed1f16));
    assert.ok(result.simulation.requestHash);
    assert.ok(result.simulation.responseHash);

    // Evidence: provider id, chain, block, and the hashes that bind the request
    // (blueprintHash + callsHash) and the response (gas, call results, assets).
    assert.equal(result.evidence.provider.id, ALCHEMY_SIMULATION_PROVIDER_ID_V1);
    assert.equal(result.evidence.chainId, 8453);
    assert.equal(result.evidence.blockNumber, String(0x2ed1f16));
    assert.equal(result.evidence.requestHash, result.simulation.requestHash);
    assert.equal(result.evidence.responseHash, result.simulation.responseHash);
    assert.equal(result.evidence.freeOrPaid, 'paid');
    assert.equal(result.evidence.validationStatus, 'valid');

    // The validated response the responseHash was computed over.
    assert.equal(result.response.gasUsed, String(0x11170 + 0x5208));
    assert.deepEqual(result.response.callResults?.map((entry) => entry.index), [0, 1]);
    assert.equal(result.response.assetChanges?.status, 'available');
    assert.equal(result.response.assetChanges?.changes[0].amountAtomic, '2000000');
    // The blueprint's calls hash is what the adapter was asked to honour.
    assert.equal(hashApprovedCallsV1(T59_BLUEPRINT_FIXTURE.calls), T59_BLUEPRINT_FIXTURE.callsHash);
  });

  it('a reverted simulation is still a delivered, paid answer — not a provider failure', async () => {
    const { repository, routeRunId, blueprintId } = await seedPaidSimulationFixture();
    const charge = pendingCharge(routeRunId, blueprintId, 'idem-alchemy-revert');
    await repository.insertIntelligenceCharge(routeRunId, charge);

    const result = await runPaidSimulationV1(
      {
        repository,
        provider: createAlchemySimulationProviderV1({
          apiKey: API_KEY,
          fetchImpl: alchemyFetch([
            { status: '0x1', gasUsed: '0x11170', logs: [] },
            { status: '0x0', gasUsed: '0x5208', logs: [], error: { message: 'STF' } },
          ]),
        }),
        now: () => NOW,
        price: SIMULATION_PRICE,
        chargeProvider: { ...SIMULATION_PROVIDER_REF, id: ALCHEMY_SIMULATION_PROVIDER_ID_V1 },
      },
      {
        tenantId: charge.tenantId,
        walletAddress: WALLET_ADDRESS,
        routeRunId,
        blueprintId,
        settlement: settlement(`0x${'b'.repeat(64)}`),
        existingCharge: charge,
      },
    );

    assert.equal(result.outcome, 'simulated');
    if (result.outcome !== 'simulated') throw new Error('unreachable');
    assert.equal(result.simulation.status, 'failed');
    assert.equal(result.simulation.errorCode, 'reverted');
    assert.equal(result.charge.serviceState, 'delivered');
    assert.deepEqual(result.evidence.validationErrors, ['simulation_reverted']);
    assert.equal(result.response.failedCallIndex, 1);
    assert.equal(result.response.revertReason, 'STF');
  });

  it('an Alchemy transport failure after settlement is paid_service_failed with the typed code — never a bare crash', async () => {
    for (const [fetchImpl, expected] of [
      [
        (async () => {
          throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
        }) as unknown as typeof fetch,
        'provider_timeout',
      ],
      [
        (async () => new Response('{}', { status: 429 })) as unknown as typeof fetch,
        'provider_rate_limited',
      ],
      [
        (async (_url: string, init?: RequestInit) => {
          const id = JSON.parse(String(init?.body)).id as string;
          return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: [{ number: '0x1', calls: [] }] }), { status: 200 });
        }) as unknown as typeof fetch,
        'provider_call_count_mismatch',
      ],
    ] as const) {
      const { repository, routeRunId, blueprintId } = await seedPaidSimulationFixture();
      const charge = pendingCharge(routeRunId, blueprintId, `idem-${expected}`);
      await repository.insertIntelligenceCharge(routeRunId, charge);

      const result = await runPaidSimulationV1(
        {
          repository,
          provider: createAlchemySimulationProviderV1({ apiKey: API_KEY, fetchImpl }),
          now: () => NOW,
          price: SIMULATION_PRICE,
          chargeProvider: { ...SIMULATION_PROVIDER_REF, id: ALCHEMY_SIMULATION_PROVIDER_ID_V1 },
        },
        {
          tenantId: charge.tenantId,
          walletAddress: WALLET_ADDRESS,
          routeRunId,
          blueprintId,
          settlement: settlement(`0x${expected.slice(9, 10).repeat(64)}`),
          existingCharge: charge,
        },
      );

      assert.equal(result.outcome, 'paid_service_failed');
      if (result.outcome !== 'paid_service_failed') throw new Error('unreachable');
      assert.equal(result.reason, expected);
      // Money moved and is recorded; the service is honestly marked failed.
      assert.equal(result.charge.paymentState, 'settled');
      assert.equal(result.charge.serviceState, 'failed');
      assert.ok(result.charge.x402ReceiptHash);
      assert.equal(result.simulation.status, 'unavailable');
      assert.equal(result.simulation.errorCode, expected);
    }
  });

  it('a settled-but-undelivered retry re-runs the provider WITHOUT a second payment', async () => {
    const { repository, routeRunId, blueprintId } = await seedPaidSimulationFixture();
    const charge = pendingCharge(routeRunId, blueprintId, 'idem-alchemy-retry');
    await repository.insertIntelligenceCharge(routeRunId, charge);
    const counter = { count: 0 };
    const deps = {
      repository,
      provider: createAlchemySimulationProviderV1({ apiKey: API_KEY, fetchImpl: alchemyFetch(SUCCESS_CALLS, counter) }),
      now: () => NOW,
      price: SIMULATION_PRICE,
      chargeProvider: { ...SIMULATION_PROVIDER_REF, id: ALCHEMY_SIMULATION_PROVIDER_ID_V1 },
    };
    const base = {
      tenantId: charge.tenantId,
      walletAddress: WALLET_ADDRESS as `0x${string}`,
      routeRunId,
      blueprintId,
    };

    const first = await runPaidSimulationV1(deps, { ...base, settlement: settlement(), existingCharge: charge });
    assert.equal(first.outcome, 'simulated');
    if (first.outcome !== 'simulated') throw new Error('unreachable');
    const receiptAfterFirst = first.charge.x402ReceiptHash;

    // Service retry: settlement is null — the coordinator must not re-settle.
    const retry = await runPaidSimulationV1(deps, { ...base, settlement: null, existingCharge: first.charge });
    assert.equal(retry.outcome, 'simulated');
    if (retry.outcome !== 'simulated') throw new Error('unreachable');
    assert.equal(retry.charge.x402ReceiptHash, receiptAfterFirst, 'the receipt is never replaced');
    assert.equal(retry.charge.paymentState, 'settled');
    assert.equal(counter.count, 2, 'the provider ran again');

    // Exactly one charge row for this idempotency key — no duplicate charge.
    const charges = await repository.listIntelligenceCharges(routeRunId, charge.tenantId);
    assert.equal(charges.filter((entry) => entry.charge.idempotencyKey === 'idem-alchemy-retry').length, 1);
  });
});
