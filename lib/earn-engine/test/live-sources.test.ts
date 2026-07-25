import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MOONWELL_MARKETS_ENDPOINT_V1,
  MORPHO_GRAPHQL_ENDPOINT_V1,
  PINNED_BASE_USDC_V1,
  createMoonwellEarnDataSourceV1,
  createMorphoEarnDataSourceV1,
  pinnedEarnVenueV1,
  type EarnChainReaderV1,
  type EarnDataSourceObserveInput,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// T63A §7 — live Moonwell/Morpho adapters, driven ENTIRELY by recorded provider
// payloads. The global fetch is replaced with a detonator for the whole file:
// any adapter that reached the network instead of using its injected fetch
// would fail the suite loudly, which is what keeps "no live calls in tests"
// enforced rather than merely intended.
// ---------------------------------------------------------------------------

globalThis.fetch = (() => {
  throw new Error('live network call attempted in a unit test');
}) as unknown as typeof fetch;

const NOW = new Date('2026-07-25T08:45:30.000Z');
const MOONWELL_VENUE = pinnedEarnVenueV1('moonwell');
const MORPHO_VENUE = pinnedEarnVenueV1('morpho');
const MOONWELL_OBSERVED_AT = '2026-07-25T08:45:16.841Z';
const MORPHO_OBSERVED_AT = '2026-07-25T08:45:11.000Z';
const MORPHO_TIMESTAMP = Math.floor(Date.parse(MORPHO_OBSERVED_AT) / 1000);

function moonwellInput(overrides: Partial<EarnDataSourceObserveInput> = {}): EarnDataSourceObserveInput {
  return { protocol: 'moonwell', venue: MOONWELL_VENUE, amountAtomic: '500000000', now: NOW, ...overrides };
}

function morphoInput(overrides: Partial<EarnDataSourceObserveInput> = {}): EarnDataSourceObserveInput {
  return { protocol: 'morpho', venue: MORPHO_VENUE, amountAtomic: '500000000', now: NOW, ...overrides };
}

// --- Recorded payloads (shape + values taken from the real endpoints) -------

function moonwellMarketsPayload(overrides: Record<string, unknown> = {}, metaOverrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: [
      {
        asset: 'cbBTC',
        assetAddress: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
        mToken: 'mcbBTC',
        mTokenAddress: '0xF877ACaFA28c19b96727966690b2f44d35aD5976',
        deprecated: false,
        baseSupplyApy: 0.1541626959,
        totalSupplyApr: 0.3070837053,
        liquidityUsd: 9727771.44544864,
      },
      {
        asset: 'USDC',
        assetAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        mToken: 'mUSDC',
        mTokenAddress: '0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22',
        deprecated: false,
        baseSupplyApy: 17.7743806352,
        totalSupplyApr: 18.1240594179,
        totalSupplyUsd: 14468585.19252058,
        liquidityUsd: 1214587.9041458238,
        utilization: 0.9160534435133508,
        collateralFactor: 0.88,
        ...overrides,
      },
    ],
    meta: { command: 'markets', chain: 'eip155:8453', timestamp: MOONWELL_OBSERVED_AT, ...metaOverrides },
  };
}

function morphoVaultPayload(
  vaultOverrides: Record<string, unknown> = {},
  stateOverrides: Record<string, unknown> = {},
) {
  return {
    data: {
      vaultByAddress: {
        address: '0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca',
        name: 'Moonwell Flagship USDC',
        symbol: 'mwUSDC',
        chain: { id: 8453 },
        asset: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
        state: {
          timestamp: MORPHO_TIMESTAMP,
          blockNumber: 49089882,
          netApy: 0.045375627541667525,
          netApyExcludingRewards: 0.03926325709862913,
          fee: 0.15,
          totalAssets: 9542636897974,
          allRewards: [{ supplyApr: 0.006112370446315816 }],
          ...stateOverrides,
        },
        liquidity: { underlying: 9542636897974 },
        ...vaultOverrides,
      },
    },
  };
}

// --- Injected transports ----------------------------------------------------

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function jsonFetch(payload: unknown, status = 200, calls: FetchCall[] = []): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

function throwingFetch(error: Error): typeof fetch {
  return (async () => {
    throw error;
  }) as unknown as typeof fetch;
}

function chainReader(snapshot: {
  blockNumber?: string;
  underlyingAsset?: `0x${string}`;
  availableLiquidityAtomic?: string;
}): EarnChainReaderV1 {
  return {
    async readMoonwellMarketSnapshot() {
      return {
        blockNumber: snapshot.blockNumber ?? '49089882',
        underlyingAsset: snapshot.underlyingAsset ?? PINNED_BASE_USDC_V1,
        availableLiquidityAtomic: snapshot.availableLiquidityAtomic ?? '1214587904145',
      };
    },
  };
}

function failureReason(result: { ok: boolean; reason?: string }): string {
  assert.equal(result.ok, false, 'expected a typed failure');
  return String(result.reason);
}

describe('MoonwellEarnDataSourceV1', () => {
  test('parses a live markets response into integer-bps evidence bound to the pinned market', async () => {
    const calls: FetchCall[] = [];
    const source = createMoonwellEarnDataSourceV1({
      fetchImpl: jsonFetch(moonwellMarketsPayload(), 200, calls),
      chainReader: chainReader({}),
    });
    const result = await source.observe(moonwellInput());

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const observation = result.observation;
    // 17.7743806352% → 1777 bps; incentives are the difference to totalSupplyApr.
    assert.equal(observation.baseApyBps, 1777);
    assert.equal(observation.rewardApyBps, 1812 - 1777);
    assert.equal(observation.netApyBps, 1812);
    for (const value of [observation.baseApyBps, observation.rewardApyBps, observation.netApyBps]) {
      assert.equal(Number.isInteger(value), true, 'APY must be integer basis points');
    }
    // Liquidity + block come from the on-chain anchor, never from liquidityUsd.
    assert.equal(observation.availableLiquidityAtomic, '1214587904145');
    assert.equal(observation.blockNumber, '49089882');
    assert.equal(observation.observedAt, MOONWELL_OBSERVED_AT);
    assert.equal(observation.expiresAt, new Date(Date.parse(MOONWELL_OBSERVED_AT) + 5 * 60_000).toISOString());
    assert.equal(observation.providerId, 'moonwell-api-v1');
    assert.equal(observation.providerDisplayName, 'Moonwell API');
    assert.equal(observation.providerOperator, 'Moonwell');
    assert.equal(observation.sourceIndependence, 'unknown');
    assert.match(observation.requestHash, /^0x[0-9a-f]{64}$/);
    assert.match(observation.responseHash, /^0x[0-9a-f]{64}$/);
    assert.notEqual(observation.requestHash, observation.responseHash);
    // Read-only: exactly one GET against the official endpoint.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, MOONWELL_MARKETS_ENDPOINT_V1);
    assert.equal(calls[0].init?.method, 'GET');
  });

  test('identical payloads hash identically; a changed payload does not', async () => {
    const source = createMoonwellEarnDataSourceV1({ fetchImpl: jsonFetch(moonwellMarketsPayload()) });
    const first = await source.observe(moonwellInput());
    const second = await source.observe(moonwellInput());
    const changed = await createMoonwellEarnDataSourceV1({
      fetchImpl: jsonFetch(moonwellMarketsPayload({ baseSupplyApy: 5.5 })),
    }).observe(moonwellInput());
    assert.equal(first.ok && second.ok && changed.ok, true);
    if (!first.ok || !second.ok || !changed.ok) return;
    assert.equal(first.observation.responseHash, second.observation.responseHash);
    assert.notEqual(first.observation.responseHash, changed.observation.responseHash);
    assert.equal(changed.observation.baseApyBps, 550);
  });

  test('rejects a response that is not bound to chain 8453 / canonical USDC / the pinned market', async () => {
    const wrongChain = await createMoonwellEarnDataSourceV1({
      fetchImpl: jsonFetch(moonwellMarketsPayload({}, { chain: 'eip155:10' })),
    }).observe(moonwellInput());
    assert.equal(failureReason(wrongChain), 'pinned_chain_mismatch');

    const wrongAsset = await createMoonwellEarnDataSourceV1({
      fetchImpl: jsonFetch(moonwellMarketsPayload({ assetAddress: '0x4200000000000000000000000000000000000006' })),
    }).observe(moonwellInput());
    assert.equal(failureReason(wrongAsset), 'pinned_asset_mismatch');

    const wrongMarket = await createMoonwellEarnDataSourceV1({
      fetchImpl: jsonFetch(moonwellMarketsPayload({ mTokenAddress: '0x1111111111111111111111111111111111111111' })),
    }).observe(moonwellInput());
    assert.equal(failureReason(wrongMarket), 'provider_venue_missing');

    const deprecated = await createMoonwellEarnDataSourceV1({
      fetchImpl: jsonFetch(moonwellMarketsPayload({ deprecated: true })),
    }).observe(moonwellInput());
    assert.equal(failureReason(deprecated), 'pinned_venue_deprecated');
  });

  test('an on-chain underlying that disagrees with the pinned asset fails closed', async () => {
    const result = await createMoonwellEarnDataSourceV1({
      fetchImpl: jsonFetch(moonwellMarketsPayload()),
      chainReader: chainReader({ underlyingAsset: '0x4200000000000000000000000000000000000006' }),
    }).observe(moonwellInput());
    assert.equal(failureReason(result), 'pinned_asset_mismatch');
  });

  test('an unavailable chain reader costs liquidity and block, not the whole reading', async () => {
    const source = createMoonwellEarnDataSourceV1({
      fetchImpl: jsonFetch(moonwellMarketsPayload()),
      chainReader: {
        async readMoonwellMarketSnapshot() {
          throw new Error('rpc down');
        },
      },
    });
    const result = await source.observe(moonwellInput());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.observation.availableLiquidityAtomic, null);
    assert.equal(result.observation.blockNumber, null);
    assert.equal(result.observation.baseApyBps, 1777);
  });

  test('transport and HTTP failures map to the typed taxonomy', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    assert.equal(
      failureReason(
        await createMoonwellEarnDataSourceV1({ fetchImpl: throwingFetch(timeout) }).observe(moonwellInput()),
      ),
      'provider_timeout',
    );
    assert.equal(
      failureReason(
        await createMoonwellEarnDataSourceV1({ fetchImpl: throwingFetch(new Error('ECONNREFUSED')) }).observe(
          moonwellInput(),
        ),
      ),
      'provider_unreachable',
    );
    assert.equal(
      failureReason(
        await createMoonwellEarnDataSourceV1({ fetchImpl: jsonFetch({}, 500) }).observe(moonwellInput()),
      ),
      'provider_http_error',
    );
    assert.equal(
      failureReason(
        await createMoonwellEarnDataSourceV1({ fetchImpl: jsonFetch({}, 429) }).observe(moonwellInput()),
      ),
      'provider_rate_limited',
    );
    assert.equal(
      failureReason(
        await createMoonwellEarnDataSourceV1({ fetchImpl: jsonFetch('not json at all') }).observe(moonwellInput()),
      ),
      'provider_invalid_response',
    );
    assert.equal(
      failureReason(
        await createMoonwellEarnDataSourceV1({ fetchImpl: jsonFetch({ success: true, data: [] }) }).observe(
          moonwellInput(),
        ),
      ),
      'provider_invalid_response',
    );
  });

  test('an absurd APY is rejected rather than published', async () => {
    const result = await createMoonwellEarnDataSourceV1({
      fetchImpl: jsonFetch(moonwellMarketsPayload({ baseSupplyApy: 99_999_999 })),
    }).observe(moonwellInput());
    assert.equal(failureReason(result), 'apy_out_of_range');
  });

  test('refuses a non-allowlisted endpoint before any socket is opened', async () => {
    let called = false;
    const source = createMoonwellEarnDataSourceV1({
      endpoint: 'https://moonwell-api.example.com/v1/markets?chain=base',
      fetchImpl: (async () => {
        called = true;
        return new Response('{}');
      }) as unknown as typeof fetch,
    });
    assert.equal(failureReason(await source.observe(moonwellInput())), 'provider_host_not_allowlisted');
    assert.equal(called, false);
  });

  test('only answers for its own protocol', async () => {
    const result = await createMoonwellEarnDataSourceV1({ fetchImpl: jsonFetch(moonwellMarketsPayload()) }).observe(
      morphoInput(),
    );
    assert.equal(failureReason(result), 'unsupported_protocol');
  });
});

describe('MorphoEarnDataSourceV1', () => {
  test('parses a live vault response with rewards, liquidity and block, all bound to the pinned vault', async () => {
    const calls: FetchCall[] = [];
    const source = createMorphoEarnDataSourceV1({ fetchImpl: jsonFetch(morphoVaultPayload(), 200, calls) });
    const result = await source.observe(morphoInput());

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const observation = result.observation;
    // Native yield NET of the 15% fee, incentives reported separately.
    assert.equal(observation.baseApyBps, 393);
    assert.equal(observation.rewardApyBps, 61);
    assert.equal(observation.netApyBps, 454);
    assert.equal(observation.netApyBps! <= observation.baseApyBps! + observation.rewardApyBps!, true);
    assert.equal(observation.availableLiquidityAtomic, '9542636897974');
    assert.equal(observation.blockNumber, '49089882');
    assert.equal(observation.fees.performanceFeeBps, 1500);
    assert.equal(observation.withdrawalTerms.model, 'vault_redeem');
    assert.equal(observation.observedAt, MORPHO_OBSERVED_AT);
    assert.equal(observation.providerId, 'morpho-api-v1');
    assert.equal(observation.providerOperator, 'Morpho Labs');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, MORPHO_GRAPHQL_ENDPOINT_V1);
    assert.equal(calls[0].init?.method, 'POST');
    // The pinned vault + chain are the ONLY query variables — no discovery.
    const body = JSON.parse(String(calls[0].init?.body));
    assert.deepEqual(body.variables, { address: MORPHO_VENUE.target, chainId: 8453 });
    assert.equal(/vaultByAddress/.test(body.query), true);
  });

  test('net APY is clamped to its own composition, never inflated above it', async () => {
    const result = await createMorphoEarnDataSourceV1({
      fetchImpl: jsonFetch(morphoVaultPayload({}, { netApy: 0.9, netApyExcludingRewards: 0.01, allRewards: [] })),
    }).observe(morphoInput());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.observation.baseApyBps, 100);
    assert.equal(result.observation.rewardApyBps, 0);
    assert.equal(result.observation.netApyBps, 100);
  });

  test('rejects a vault response that is not the pinned Base USDC vault', async () => {
    const wrongChain = await createMorphoEarnDataSourceV1({
      fetchImpl: jsonFetch(morphoVaultPayload({ chain: { id: 1 } })),
    }).observe(morphoInput());
    assert.equal(failureReason(wrongChain), 'pinned_chain_mismatch');

    const wrongVault = await createMorphoEarnDataSourceV1({
      fetchImpl: jsonFetch(morphoVaultPayload({ address: '0x2222222222222222222222222222222222222222' })),
    }).observe(morphoInput());
    assert.equal(failureReason(wrongVault), 'pinned_contract_mismatch');

    const wrongAsset = await createMorphoEarnDataSourceV1({
      fetchImpl: jsonFetch(
        morphoVaultPayload({ asset: { address: '0x4200000000000000000000000000000000000006', decimals: 18 } }),
      ),
    }).observe(morphoInput());
    assert.equal(failureReason(wrongAsset), 'pinned_asset_mismatch');

    const missing = await createMorphoEarnDataSourceV1({
      fetchImpl: jsonFetch({ data: { vaultByAddress: null } }),
    }).observe(morphoInput());
    assert.equal(failureReason(missing), 'provider_venue_missing');
  });

  test('a GraphQL 200 carrying errors is a failure, not an empty reading', async () => {
    const result = await createMorphoEarnDataSourceV1({
      fetchImpl: jsonFetch({ errors: [{ message: 'Cannot query field' }] }),
    }).observe(morphoInput());
    assert.equal(failureReason(result), 'provider_invalid_response');
  });

  test('transport failures and absurd APY map to the typed taxonomy', async () => {
    const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    assert.equal(
      failureReason(await createMorphoEarnDataSourceV1({ fetchImpl: throwingFetch(timeout) }).observe(morphoInput())),
      'provider_timeout',
    );
    assert.equal(
      failureReason(await createMorphoEarnDataSourceV1({ fetchImpl: jsonFetch({}, 503) }).observe(morphoInput())),
      'provider_http_error',
    );
    assert.equal(
      failureReason(
        await createMorphoEarnDataSourceV1({
          fetchImpl: jsonFetch(morphoVaultPayload({}, { netApy: 1_000 })),
        }).observe(morphoInput()),
      ),
      'apy_out_of_range',
    );
  });

  test('a missing APY leg becomes a null datum, never a fabricated zero', async () => {
    const result = await createMorphoEarnDataSourceV1({
      fetchImpl: jsonFetch(
        morphoVaultPayload({ liquidity: null }, { netApy: null, netApyExcludingRewards: null, allRewards: null }),
      ),
    }).observe(morphoInput());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.observation.baseApyBps, null);
    assert.equal(result.observation.rewardApyBps, null);
    assert.equal(result.observation.netApyBps, null);
    // liquidity falls back to totalAssets only because the liquidity leg is absent
    assert.equal(result.observation.availableLiquidityAtomic, '9542636897974');
  });

  test('only answers for its own protocol', async () => {
    const result = await createMorphoEarnDataSourceV1({ fetchImpl: jsonFetch(morphoVaultPayload()) }).observe(
      moonwellInput(),
    );
    assert.equal(failureReason(result), 'unsupported_protocol');
  });
});
