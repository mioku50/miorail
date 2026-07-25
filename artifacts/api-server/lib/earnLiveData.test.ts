import assert from 'node:assert/strict';
import test, { afterEach, describe } from 'node:test';
import { PINNED_BASE_USDC_V1, pinnedEarnVenueV1 } from '@mioagent/earn-engine';
import {
  createViemEarnChainReaderV1,
  resetEarnDataSourceV1,
  resolveEarnDataSourceV1,
  resolveEarnLiveDataConfigV1,
  type EarnLiveRpcClientV1,
} from './earnLiveData.js';

// ---------------------------------------------------------------------------
// T63A — production wiring of the live earn data source. Every seam (fetch,
// RPC, env) is injected, so this suite proves the wiring without a single live
// call: the global fetch is a detonator for the whole file.
// ---------------------------------------------------------------------------

globalThis.fetch = (() => {
  throw new Error('live network call attempted in a unit test');
}) as unknown as typeof fetch;

const NOW = new Date('2026-07-25T08:45:30.000Z');
const MOONWELL_VENUE = pinnedEarnVenueV1('moonwell');

const MOONWELL_PAYLOAD = {
  success: true,
  data: [
    {
      asset: 'USDC',
      assetAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      mToken: 'mUSDC',
      mTokenAddress: '0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22',
      deprecated: false,
      baseSupplyApy: 5.2,
      totalSupplyApr: 5.8,
    },
  ],
  meta: { chain: 'eip155:8453', timestamp: '2026-07-25T08:45:16.841Z' },
};

function payloadFetch(calls: string[] = []): typeof fetch {
  return (async (url: string) => {
    calls.push(String(url));
    return new Response(JSON.stringify(MOONWELL_PAYLOAD), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

function fakeRpc(overrides: Partial<{ block: bigint; cash: bigint; underlying: string }> = {}): EarnLiveRpcClientV1 {
  return {
    async getBlockNumber() {
      return overrides.block ?? 49089882n;
    },
    async readContract({ functionName }) {
      if (functionName === 'getCash') return overrides.cash ?? 1214587904145n;
      if (functionName === 'underlying') return overrides.underlying ?? PINNED_BASE_USDC_V1;
      throw new Error(`unexpected call ${functionName}`);
    },
  };
}

afterEach(() => {
  resetEarnDataSourceV1();
});

describe('resolveEarnLiveDataConfigV1', () => {
  test('defaults to live data with a short cache and a bounded request timeout', () => {
    const config = resolveEarnLiveDataConfigV1({});
    assert.equal(config.liveEnabled, true);
    assert.equal(config.chainReadsEnabled, true);
    assert.equal(config.requestTimeoutMs, 6_000);
    assert.equal(config.freshnessTtlMs, 300_000);
    assert.equal(config.cacheTtlMs, 30_000);
    assert.equal(config.cacheErrorTtlMs, 5_000);
    assert.equal(config.staleServeMs, 900_000);
  });

  test('every duration is operator-configurable, and garbage falls back to the default', () => {
    const config = resolveEarnLiveDataConfigV1({
      MIORAIL_EARN_LIVE_DATA: 'false',
      MIORAIL_EARN_LIVE_CHAIN_READS: 'false',
      EARN_LIVE_FRESHNESS_TTL_MS: '90000',
      EARN_LIVE_CACHE_TTL_MS: '15000',
      EARN_LIVE_REQUEST_TIMEOUT_MS: 'not-a-number',
    } as NodeJS.ProcessEnv);
    assert.equal(config.liveEnabled, false);
    assert.equal(config.chainReadsEnabled, false);
    assert.equal(config.freshnessTtlMs, 90_000);
    assert.equal(config.cacheTtlMs, 15_000);
    assert.equal(config.requestTimeoutMs, 6_000);
  });
});

describe('createViemEarnChainReaderV1', () => {
  test('maps getCash / underlying / block into the pinned market snapshot', async () => {
    const snapshot = await createViemEarnChainReaderV1(fakeRpc()).readMoonwellMarketSnapshot({
      market: MOONWELL_VENUE.target,
    });
    assert.deepEqual(snapshot, {
      blockNumber: '49089882',
      underlyingAsset: PINNED_BASE_USDC_V1,
      availableLiquidityAtomic: '1214587904145',
    });
  });

  test('an unreadable value throws rather than returning a partial snapshot', async () => {
    const reader = createViemEarnChainReaderV1({
      async getBlockNumber() {
        return 1n;
      },
      async readContract({ functionName }) {
        return functionName === 'getCash' ? undefined : PINNED_BASE_USDC_V1;
      },
    });
    await assert.rejects(() => reader.readMoonwellMarketSnapshot({ market: MOONWELL_VENUE.target }));
  });
});

describe('resolveEarnDataSourceV1', () => {
  test('builds the live source and binds the on-chain liquidity/block anchor', async () => {
    const calls: string[] = [];
    const source = resolveEarnDataSourceV1({
      env: {} as NodeJS.ProcessEnv,
      fetchImpl: payloadFetch(calls),
      createRpcClient: () => fakeRpc(),
    });
    const result = await source.observe({
      protocol: 'moonwell',
      venue: MOONWELL_VENUE,
      amountAtomic: '500000000',
      now: NOW,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.observation.providerId, 'moonwell-api-v1');
    assert.equal(result.observation.baseApyBps, 520);
    assert.equal(result.observation.rewardApyBps, 60);
    assert.equal(result.observation.availableLiquidityAtomic, '1214587904145');
    assert.equal(result.observation.blockNumber, '49089882');
    assert.equal(calls.length, 1);
  });

  test('is a process-wide singleton, so the observation cache is actually shared', async () => {
    const calls: string[] = [];
    const deps = {
      env: {} as NodeJS.ProcessEnv,
      fetchImpl: payloadFetch(calls),
      createRpcClient: () => fakeRpc(),
    };
    const first = resolveEarnDataSourceV1(deps);
    const second = resolveEarnDataSourceV1(deps);
    assert.equal(first, second);
    const input = { protocol: 'moonwell' as const, venue: MOONWELL_VENUE, amountAtomic: '500000000', now: NOW };
    await Promise.all([first.observe(input), second.observe(input), first.observe(input)]);
    assert.equal(calls.length, 1, 'concurrent comparisons collapse to one upstream call');
  });

  test('the kill switch falls back to the deterministic curated source, never to invented live data', async () => {
    const source = resolveEarnDataSourceV1({
      env: { MIORAIL_EARN_LIVE_DATA: 'false' } as NodeJS.ProcessEnv,
      fetchImpl: (() => {
        throw new Error('must not fetch when live data is disabled');
      }) as unknown as typeof fetch,
    });
    const result = await source.observe({
      protocol: 'moonwell',
      venue: MOONWELL_VENUE,
      amountAtomic: '500000000',
      now: NOW,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.observation.providerId, 'curated-earn-v1');
  });

  test('with chain reads disabled the reading still stands, minus liquidity and block', async () => {
    const source = resolveEarnDataSourceV1({
      env: { MIORAIL_EARN_LIVE_CHAIN_READS: 'false' } as NodeJS.ProcessEnv,
      fetchImpl: payloadFetch(),
      createRpcClient: () => {
        throw new Error('must not build an RPC client when chain reads are disabled');
      },
    });
    const result = await source.observe({
      protocol: 'moonwell',
      venue: MOONWELL_VENUE,
      amountAtomic: '500000000',
      now: NOW,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.observation.availableLiquidityAtomic, null);
    assert.equal(result.observation.blockNumber, null);
    assert.equal(result.observation.baseApyBps, 520);
  });
});
