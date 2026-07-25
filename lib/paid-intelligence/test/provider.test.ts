import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHttpSimulationProvider, resolveSimulationProviderConfigV1 } from '../src/provider.js';
import { SimulationProviderResponseV1Schema } from '../src/schemas.js';
import { WALLET_ADDRESS } from './fixtures.js';

describe('resolveSimulationProviderConfigV1', () => {
  it('is unconfigured (fail closed) when no env vars are set', () => {
    const config = resolveSimulationProviderConfigV1({});
    assert.equal(config.configured, false);
    assert.equal(config.missingReason, 'not_configured');
  });

  it('is unconfigured when the allowlist is empty even with a URL set', () => {
    const config = resolveSimulationProviderConfigV1({
      MIORAIL_SIMULATION_PROVIDER_URL: 'https://sim.example.test/simulate',
    });
    assert.equal(config.configured, false);
    assert.equal(config.missingReason, 'not_configured');
  });

  it('is unconfigured when the URL host is not in the allowlist (fail closed, not fallback)', () => {
    const config = resolveSimulationProviderConfigV1({
      MIORAIL_SIMULATION_PROVIDER_URL: 'https://evil.example.test/simulate',
      MIORAIL_SIMULATION_PROVIDER_ALLOWLIST: 'sim.example.test,other.example.test',
    });
    assert.equal(config.configured, false);
    assert.equal(config.missingReason, 'host_not_allowlisted');
  });

  it('is unconfigured on a malformed URL', () => {
    const config = resolveSimulationProviderConfigV1({
      MIORAIL_SIMULATION_PROVIDER_URL: 'not-a-url',
      MIORAIL_SIMULATION_PROVIDER_ALLOWLIST: 'sim.example.test',
    });
    assert.equal(config.configured, false);
    assert.equal(config.missingReason, 'invalid_url');
  });

  it('N3: rejects a plain-http provider URL even with an allowlisted host (https required, fail closed)', () => {
    const config = resolveSimulationProviderConfigV1({
      MIORAIL_SIMULATION_PROVIDER_URL: 'http://sim.example.test/simulate',
      MIORAIL_SIMULATION_PROVIDER_ALLOWLIST: 'sim.example.test',
    });
    assert.equal(config.configured, false);
    assert.equal(config.missingReason, 'invalid_url');
  });

  it('resolves the configured provider when the URL host is allowlisted', () => {
    const config = resolveSimulationProviderConfigV1({
      MIORAIL_SIMULATION_PROVIDER_URL: 'https://sim.example.test/simulate',
      MIORAIL_SIMULATION_PROVIDER_ALLOWLIST: 'sim.example.test',
      MIORAIL_SIMULATION_PROVIDER_ID: 'generic-sim-v1',
    });
    assert.equal(config.configured, true);
    assert.equal(config.url, 'https://sim.example.test/simulate');
    assert.equal(config.providerId, 'generic-sim-v1');
    assert.equal(config.kind, 'generic_http');
  });

  // T63B §7 — the provider set is CLOSED. Before T63B an arbitrary id rode the
  // generic URL config; now an id nobody implements resolves to nothing, so the
  // route 503s before an x402 challenge is ever issued.
  it('fails closed on an unknown provider id even with a valid allowlisted URL', () => {
    const config = resolveSimulationProviderConfigV1({
      MIORAIL_SIMULATION_PROVIDER_URL: 'https://sim.example.test/simulate',
      MIORAIL_SIMULATION_PROVIDER_ALLOWLIST: 'sim.example.test',
      MIORAIL_SIMULATION_PROVIDER_ID: 'acme-sim',
    });
    assert.equal(config.configured, false);
    assert.equal(config.missingReason, 'unknown_provider');
    assert.equal(config.url, undefined);
  });

  it('defaults providerId to generic-sim-v1', () => {
    const config = resolveSimulationProviderConfigV1({
      MIORAIL_SIMULATION_PROVIDER_URL: 'https://sim.example.test/simulate',
      MIORAIL_SIMULATION_PROVIDER_ALLOWLIST: 'sim.example.test',
    });
    assert.equal(config.providerId, 'generic-sim-v1');
  });
});

describe('createHttpSimulationProvider', () => {
  it('sends only the whitelisted fields (chainId/from/calls/blockTag) — no secrets, chat, tenantId', async () => {
    let capturedBody: unknown;
    let capturedUrl: string | Request | undefined;
    const provider = createHttpSimulationProvider({
      url: 'https://sim.example.test/simulate',
      providerId: 'test-provider',
      fetchImpl: (async (input: unknown, init?: RequestInit) => {
        capturedUrl = input as string;
        capturedBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({ status: 'success', blockNumber: 123, gasUsed: '1', stateChanges: [], revertReason: null }),
          { status: 200 },
        );
      }) as typeof fetch,
    });

    const result = await provider.simulate({
      chainId: 8453,
      walletAddress: WALLET_ADDRESS,
      blueprintHash: `0x${'1'.repeat(64)}`,
      callsHash: `0x${'2'.repeat(64)}`,
      calls: [
        {
          index: 0,
          callType: 'swap',
          to: '0x3333333333333333333333333333333333333333',
          valueWei: '0',
          data: '0x1234',
          asset: null,
          amountAtomic: null,
          recipient: null,
          spender: null,
        },
      ],
    });

    assert.equal(capturedUrl, 'https://sim.example.test/simulate');
    assert.deepEqual(Object.keys(capturedBody as object).sort(), ['blockTag', 'calls', 'chainId', 'from']);
    assert.equal((capturedBody as { chainId: number }).chainId, 8453);
    assert.equal((capturedBody as { from: string }).from, WALLET_ADDRESS);
    assert.equal((capturedBody as { blockTag: string }).blockTag, 'latest');
    const calls = (capturedBody as { calls: unknown[] }).calls;
    assert.deepEqual(Object.keys(calls[0] as object).sort(), ['data', 'to', 'value']);

    assert.equal(result.ok, true);
    if (result.ok) {
      const parsed = SimulationProviderResponseV1Schema.parse(result.body);
      assert.equal(parsed.status, 'success');
    }
  });

  const ONE_CALL = [
    {
      index: 0,
      callType: 'swap' as const,
      to: '0x3333333333333333333333333333333333333333' as const,
      valueWei: '0',
      data: '0x1234' as const,
      asset: null,
      amountAtomic: null,
      recipient: null,
      spender: null,
    },
  ];

  it('reports a network/http failure as ok:false without throwing', async () => {
    const provider = createHttpSimulationProvider({
      url: 'https://sim.example.test/simulate',
      providerId: 'test-provider',
      fetchImpl: (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch,
    });
    const result = await provider.simulate({
      chainId: 8453,
      walletAddress: WALLET_ADDRESS,
      blueprintHash: `0x${'1'.repeat(64)}`,
      callsHash: `0x${'2'.repeat(64)}`,
      calls: ONE_CALL,
    });
    assert.equal(result.ok, false);
  });

  it('classifies a thrown network error as ok:false network_error', async () => {
    const provider = createHttpSimulationProvider({
      url: 'https://sim.example.test/simulate',
      providerId: 'test-provider',
      fetchImpl: (async () => {
        throw new Error('fetch failed: ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    const result = await provider.simulate({
      chainId: 8453,
      walletAddress: WALLET_ADDRESS,
      blueprintHash: `0x${'1'.repeat(64)}`,
      callsHash: `0x${'2'.repeat(64)}`,
      calls: ONE_CALL,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errorCode, 'network_error');
  });
});
