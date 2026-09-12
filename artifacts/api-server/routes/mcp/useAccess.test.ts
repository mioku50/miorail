import assert from 'node:assert/strict';
import test, { beforeEach, describe } from 'node:test';

import { rwaMarketRealityRuntime } from '../rwaMarketReality.js';
import { McpPublicError } from './tools.js';
import { miorailGetUseAccessV1, resetUseAccessCacheV1 } from './useAccessTools.js';

const NVDA = '0xb20000000000000000000078ee7ce2fe4908108c';
const STRANGER = '0x1111111111111111111111111111111111111111';

// ---------------------------------------------------------------------------
// A public tool that fans out to ten `eth_call`s and two HTTP fetches needs two
// bounds, and both are behavioural rather than advisory: the key space is the
// reviewed corpus, and one address is read once at a time.
// ---------------------------------------------------------------------------

let chainCalls = 0;
let venueLookups = 0;
let bindings: Record<string, boolean> = {};
let venueFails = false;
let poolRowsRead = 0;
let storedPools: unknown[] = [];

const restore = {
  underlyings: rwaMarketRealityRuntime.underlyings,
  useAccessReader: rwaMarketRealityRuntime.useAccessReader,
  defiSources: rwaMarketRealityRuntime.defiSources,
  migrationAvailable: rwaMarketRealityRuntime.migrationAvailable,
  poolReadings: rwaMarketRealityRuntime.poolReadings,
};

beforeEach(() => {
  resetUseAccessCacheV1();
  chainCalls = 0;
  venueLookups = 0;
  venueFails = false;
  bindings = { [NVDA]: true };
  // The pooled reading is a DB read on the production path, so the stub must
  // carry one too — a fake that omits a dependency turns a real call into a
  // test-only success.
  poolRowsRead = 0;
  rwaMarketRealityRuntime.poolReadings = (() => ({
    async recordReadings() { return { written: 0 }; },
    async readingsForToken() {
      poolRowsRead += 1;
      return storedPools;
    },
  })) as typeof rwaMarketRealityRuntime.poolReadings;

  rwaMarketRealityRuntime.migrationAvailable = async () => true;
  rwaMarketRealityRuntime.underlyings = (() => ({
    async underlyingOf({ tokenAddress }: { chainId: number; tokenAddress: string }) {
      return bindings[tokenAddress]
        ? {
            binding: { underlyingKey: 'security:isin:US67066G1040', issuerId: 'coinbase' },
            underlying: { displaySymbol: 'NVDA' },
          }
        : null;
    },
  })) as never;
  rwaMarketRealityRuntime.useAccessReader = (() => ({
    async readBlockAnchor() {
      chainCalls += 1;
      return { ok: true as const, value: { blockTag: '0x3060000' } };
    },
    async call() {
      chainCalls += 1;
      return { ok: false as const, reason: 'execution_reverted' };
    },
  })) as never;
  rwaMarketRealityRuntime.defiSources = (() => [
    {
      venueId: 'aave_v3',
      venueName: 'Aave v3',
      kind: 'chain_head' as const,
      async lookup() {
        venueLookups += 1;
        if (venueFails) throw new Error('aave read endpoint_unavailable');
        // A real fan-out takes time; without it "concurrent" is not concurrent.
        await new Promise((resolve) => setTimeout(resolve, 15));
        return {
          venueId: 'aave_v3',
          venueName: 'Aave v3',
          state: 'not_listed' as const,
          uses: { lend: null, borrow: null, collateral: null },
          curated: null,
          marketRef: null,
          reason: null,
        };
      },
    },
  ]) as never;
});

test.after(() => {
  Object.assign(rwaMarketRealityRuntime, restore);
});

describe('an assistant asking what Base said is answered from both sides', () => {
  test('the claim ledger reaches the agent output and its summary', async () => {
    // The failure this block exists for: an assistant that had read Base's
    // page and asked "does Aave support NVDAc?" had nothing on this surface
    // naming Aave's own answer, so it answered from the page.
    const reading = await miorailGetUseAccessV1({ address: NVDA });
    const ecosystem = reading.ecosystem!;
    assert.equal(ecosystem.listedBy, 'Base');
    assert.equal(ecosystem.rows.length, ecosystem.tally.named);

    const aave = ecosystem.rows.find((row) => row.appId === 'aave')!;
    assert.equal(aave.measured, 'not_listed');
    // The issuer of record is established by the binding this tool already
    // resolved, so one row is always read even with no venue at all.
    const coinbase = ecosystem.rows.find((row) => row.appId === 'coinbase')!;
    assert.equal(coinbase.measured, 'listed');
    // Euler IS bound now, and this reading carries no Euler row — a venue that
    // was not in the answer is `unchecked`, never `not_listed`. The difference
    // is the whole point of the four states: a reader must not be told a venue
    // refused when nobody asked it.
    assert.equal(ecosystem.rows.find((row) => row.appId === 'euler')!.measured, 'unchecked');

    assert.match(ecosystem.summary, /apps Miorail does not read at all/);
    // And the sentence is in the summary an assistant is told to read first.
    assert.match(reading.miorailSummary.summary, /apps Miorail does not read at all/);
  });
});

describe('an assistant asking about LP is answered from the pools', () => {
  test('the stored pools reach the agent output and the summary', async () => {
    // `defi` answers a LENDING question, and for these tokens it almost always
    // answers no — while an Aerodrome pool held 3,715 NVDAc against $1.6M of
    // USDC. This tool carried no pools at all, so an assistant asked about LP
    // read four refusals and reported "no DeFi use".
    storedPools = [{
      chainId: 8453,
      poolAddress: '0x853f5f1b92b16714fe6cda67caad0856b83c7ab9',
      tokenAddress: NVDA,
      venueId: 'aerodrome_cl',
      factoryAddress: '0xf8f2eb4940cfe7d13603dddd87f123820fc061ef',
      tokenBalanceAtomic: '371504000000',
      tokenDecimals: 8,
      pairedTokenAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      pairedBalanceAtomic: '1645701470000',
      pairedDecimals: 6,
      pairedSymbol: 'USDC',
      blockNumber: 51012269,
      readAt: '2026-09-08T09:00:00.000Z',
    }];
    const out = await miorailGetUseAccessV1({ address: NVDA });
    assert.equal(poolRowsRead, 1);
    assert.equal(out.pools.state, 'measured');
    if (out.pools.state !== 'measured') return;
    assert.equal(out.pools.poolCount, 1);
    assert.equal(out.pools.rows[0]?.venueName, 'Aerodrome CL');
    assert.equal(out.pools.rows[0]?.venueTier, 'protocol');
    assert.match(out.pools.rows[0]?.venuePageUrl ?? '', /aerodrome\.finance\/liquidity\?query=/);
    assert.match(out.miorailSummary.summary, /held by 1 pool on Base/);
    assert.match(out.miorailSummary.summary, /not depth and not a quote/);
  });

  test('no stored reading says it is our gap, never that there are no pools', async () => {
    storedPools = [];
    const out = await miorailGetUseAccessV1({ address: NVDA });
    assert.equal(out.pools.state, 'not_measured');
    if (out.pools.state !== 'not_measured') return;
    assert.match(out.pools.reason, /Not checked is not the same as none/);
    assert.match(out.miorailSummary.summary, /did not check the pools/);
  });
});

describe('the key space is the reviewed corpus, not the chain', () => {
  test('an address Miorail never bound is refused before anything is read', async () => {
    bindings = {};
    await assert.rejects(
      () => miorailGetUseAccessV1({ address: STRANGER }),
      (error: unknown) => {
        assert.ok(error instanceof McpPublicError);
        assert.equal(error.code, 'representation_not_reviewed');
        // And it says whose gap it is.
        assert.match(error.message, /never about the token/);
        return true;
      },
    );
    assert.equal(chainCalls, 0, 'a refused address must not reach the chain');
    assert.equal(venueLookups, 0, 'a refused address must not reach a venue');
  });

  test('a ticker is refused before the registry is even opened', async () => {
    let opened = 0;
    rwaMarketRealityRuntime.migrationAvailable = async () => {
      opened += 1;
      return true;
    };
    await assert.rejects(
      () => miorailGetUseAccessV1({ address: 'NVDA' }),
      (error: unknown) => {
        assert.ok(error instanceof McpPublicError);
        assert.equal(error.code, 'exact_address_required');
        return true;
      },
    );
    assert.equal(opened, 0);
    assert.equal(chainCalls, 0);
  });

  test('a storage outage is Miorail’s gap, stated as one', async () => {
    rwaMarketRealityRuntime.migrationAvailable = async () => false;
    await assert.rejects(
      () => miorailGetUseAccessV1({ address: NVDA }),
      (error: unknown) => {
        assert.ok(error instanceof McpPublicError);
        assert.equal(error.code, 'market_reality_storage_unavailable');
        assert.match(error.message, /not a statement about any address/);
        return true;
      },
    );
    assert.equal(chainCalls, 0);
  });
});

describe('one address is read once at a time', () => {
  test('concurrent callers share one fan-out', async () => {
    const [a, b, c] = await Promise.all([
      miorailGetUseAccessV1({ address: NVDA }),
      miorailGetUseAccessV1({ address: NVDA }),
      miorailGetUseAccessV1({ address: `eip155:8453:${NVDA}` }),
    ]);
    assert.equal(venueLookups, 1, 'three callers, one venue fan-out');
    // The same reading, not three that happen to agree.
    assert.equal(a.observedAt, b.observedAt);
    assert.equal(b.observedAt, c.observedAt);
    assert.equal(a.walletBound, false);
  });

  test('a second call inside the window reuses the reading, and says when it was read', async () => {
    const first = await miorailGetUseAccessV1({ address: NVDA });
    const second = await miorailGetUseAccessV1({ address: NVDA });
    assert.equal(venueLookups, 1);
    // A shared reading is not a reading pretending to be newer than it is: the
    // caller can see exactly when it was taken.
    assert.equal(second.observedAt, first.observedAt);
    assert.equal(second.defi.venues[0]?.observed?.source, 'chain_head');
  });

  test('a failed reading is never held, so one outage is not a minute of them', async () => {
    venueFails = true;
    const failed = await miorailGetUseAccessV1({ address: NVDA });
    // A venue that threw is unread for that venue, not a failed call.
    assert.equal(failed.defi.venues[0]?.state, 'unread');
    venueFails = false;
    const retried = await miorailGetUseAccessV1({ address: NVDA });
    // Cached: the reading itself succeeded, so it is reused. What must not be
    // cached is a THROWN read, checked next.
    assert.equal(retried.defi.venues[0]?.state, 'unread');

    resetUseAccessCacheV1();
    rwaMarketRealityRuntime.underlyings = (() => ({
      async underlyingOf() {
        throw new Error('connect ECONNREFUSED');
      },
    })) as never;
    await assert.rejects(() => miorailGetUseAccessV1({ address: NVDA }));
    let recovered = 0;
    rwaMarketRealityRuntime.underlyings = (() => ({
      async underlyingOf() {
        recovered += 1;
        return {
          binding: { underlyingKey: 'security:isin:US67066G1040', issuerId: 'coinbase' },
          underlying: { displaySymbol: 'NVDA' },
        };
      },
    })) as never;
    await miorailGetUseAccessV1({ address: NVDA });
    assert.equal(recovered, 1, 'the failure was not held against the next caller');
  });
});
