import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import type {
  CashExitMeasurementRunV1,
  OfficialCashExitRepositoryV1,
  RepresentationRatioRepositoryV1,
  RepresentationUnderlyingV1,
  UnderlyingAssetRepositoryV1,
} from '@mioagent/route-storage';

import { assembleMarketRealityV1 } from '../src/engine.js';
import {
  createMarketRealityCoordinatorV1,
  marketRealityQuestionHashV1,
  type MarketRealityLiveDepsV1,
} from '../src/live.js';
import { MarketRealityQuestionV1Schema } from '../src/contracts.js';

const H = `0x${'11'.repeat(32)}` as const;
const CANDIDATE = `0x${'22'.repeat(32)}` as const;
const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const UNDERLYING = 'security:isin:US67066G1040';
const NOW = new Date('2026-08-26T12:01:00.000Z');

function binding(address: string): RepresentationUnderlyingV1 {
  return {
    chainId: 8453,
    tokenAddress: address,
    underlyingKey: UNDERLYING,
    sourceKind: 'backed_assets_api',
    sourceRef: 'https://api.xstocks.fi/api/v1/token?type=btokens',
    sourceHash: 'ab'.repeat(32),
    issuerId: 'backed',
    issuerInstrumentKey: `backed:instrument_id:${address.slice(2, 6)}`,
    caip10: `eip155:8453:${address}`,
    representationKind: 'rebasing_erc20',
    evidenceStrength: 'reviewed_machine_address_mapping',
    observedBlockNumber: null,
    observedBlockHash: null,
    observedAt: '2026-08-26T12:00:00.000Z',
  };
}

/** A run whose quote window is open or closed at NOW, on demand. */
function run(address: string, options: { expiresAt: string; observedAt: string }): CashExitMeasurementRunV1 {
  return {
    schemaVersion: 'official-cash-exit-run/v1',
    runId: H,
    chainId: 8453,
    tokenAddress: address,
    scope: 'public_ladder',
    tenantId: null,
    approvedSources: ['router-a'],
    destinations: ['USDC'],
    startedAt: options.observedAt,
    completedAt: options.observedAt,
    observations: [
      {
        schemaVersion: 'official-cash-exit-observation/v1',
        observationHash: H,
        runId: H,
        chainId: 8453,
        tokenAddress: address,
        tokenSymbol: 'bNVDA',
        tokenDecimals: 18,
        scope: 'public_ladder',
        tenantId: null,
        sizeKind: 'cash_equivalent',
        requestedCashAtomic: '100000000',
        requestedTokenAtomic: null,
        testedTokenAtomic: '500000000000000000',
        destination: 'USDC',
        destinationAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        destinationDecimals: 6,
        source: 'router-a',
        status: 'full',
        evidenceStrength: 'router_quote',
        executionProven: false,
        buyQuote: {
          direction: 'buy',
          inputAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
          outputAddress: address,
          inputAtomic: '100000000',
          outputAtomic: '500000000000000000',
          routeKey: CANDIDATE,
          candidateHash: CANDIDATE,
          evidenceHash: H,
          observedAt: options.observedAt,
          expiresAt: options.expiresAt,
          blockNumber: '50000000',
          liquiditySources: ['pool-a'],
        },
        sellQuote: null,
        errorCode: null,
        observedAt: options.observedAt,
        expiresAt: options.expiresAt,
      },
    ],
  };
}

/** Open at NOW. */
const OPEN = { observedAt: '2026-08-26T12:00:55.000Z', expiresAt: '2026-08-26T12:01:15.000Z' };
/** The ordinary background sample: measured 40 minutes ago, window long closed. */
const LAPSED = { observedAt: '2026-08-26T11:21:00.000Z', expiresAt: '2026-08-26T11:21:20.000Z' };

function liveDeps(
  runs: Record<string, CashExitMeasurementRunV1>,
  hooks: { onMeasure?: (address: string) => void; resolveFails?: Set<string> } = {},
): MarketRealityLiveDepsV1 {
  const store: Record<string, CashExitMeasurementRunV1> = { ...runs };
  return {
    underlyings: {
      representationsOf: async () => [binding(A), binding(B)],
    } as unknown as UnderlyingAssetRepositoryV1,
    cashExit: {
      latestCompletedRun: async ({ tokenAddress }: { tokenAddress: string }) =>
        store[tokenAddress] ?? null,
    } as unknown as OfficialCashExitRepositoryV1,
    ratios: { readRatios: async () => [] } as unknown as RepresentationRatioRepositoryV1,
    now: () => NOW,
    approvedSources: ['router-a'],
    resolveToken: async (tokenAddress) =>
      hooks.resolveFails?.has(tokenAddress)
        ? { ok: false, reason: 'token_decimals_unavailable' }
        : { ok: true, token: { tokenAddress, symbol: 'bNVDA', decimals: 18 } },
    measureOne: async ({ token }) => {
      hooks.onMeasure?.(token.tokenAddress);
      const fresh = run(token.tokenAddress, OPEN);
      store[token.tokenAddress] = fresh;
      return fresh;
    },
  };
}

const question = (over: Record<string, unknown> = {}) =>
  MarketRealityQuestionV1Schema.parse({
    chainId: 8453,
    underlyingKey: UNDERLYING,
    direction: 'buy',
    requestedCashAtomic: '100000000',
    cashAsset: 'USDC',
    cashAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    cashDecimals: 6,
    destination: 'USDC',
    exactSizeOnly: true,
    baseOnly: true,
    ...over,
  });

describe('the exact question is the key', () => {
  test('two different sizes are two different questions', () => {
    const small = marketRealityQuestionHashV1({
      question: question(),
      approvedSources: ['router-a'],
    });
    const large = marketRealityQuestionHashV1({
      question: question({ requestedCashAtomic: '10000000000' }),
      approvedSources: ['router-a'],
    });
    assert.notEqual(small, large, 'a $10k answer must never be served for a $100 ask');
  });

  test('a different router set is a different question', () => {
    // Two measurements through different routers are not comparable, so they
    // must not be deduplicated onto each other either — the same rule the
    // coverage gate applies across representations.
    const one = marketRealityQuestionHashV1({ question: question(), approvedSources: ['router-a'] });
    const two = marketRealityQuestionHashV1({
      question: question(),
      approvedSources: ['router-a', 'router-b'],
    });
    assert.notEqual(one, two);
  });

  test('the router set order does not change the question', () => {
    assert.equal(
      marketRealityQuestionHashV1({ question: question(), approvedSources: ['a', 'b'] }),
      marketRealityQuestionHashV1({ question: question(), approvedSources: ['b', 'a'] }),
    );
  });

  test('direction and destination are part of it', () => {
    const sell = marketRealityQuestionHashV1({
      question: question({ direction: 'sell' }),
      approvedSources: ['router-a'],
    });
    const eth = marketRealityQuestionHashV1({
      question: question({ destination: 'ETH' }),
      approvedSources: ['router-a'],
    });
    const base = marketRealityQuestionHashV1({ question: question(), approvedSources: ['router-a'] });
    assert.notEqual(sell, base);
    assert.notEqual(eth, base);
  });
});

describe('measuring on demand', () => {
  test('a lapsed representation is measured; an open one is not', async () => {
    // The whole mismatch in one case. A is a background sample from 40 minutes
    // ago — real, expired, and useless as a current price. B was measured five
    // seconds ago and is still open.
    const measured: string[] = [];
    const coordinator = createMarketRealityCoordinatorV1({ now: () => NOW });
    const result = await coordinator.measure(
      liveDeps({ [A]: run(A, LAPSED), [B]: run(B, OPEN) }, { onMeasure: (a) => measured.push(a) }),
      { underlyingKey: UNDERLYING, direction: 'buy', requestedCashAtomic: '100000000' },
    );
    assert.deepEqual(measured, [A], 'only the representation that needed it');
    assert.deepEqual(result.measured, [A]);
    assert.deepEqual(result.reusedOpen, [B]);
    assert.equal(result.answer.representations.length, 2);
  });

  test('a security whose evidence is all open spends nothing', async () => {
    const measured: string[] = [];
    const coordinator = createMarketRealityCoordinatorV1({ now: () => NOW });
    const result = await coordinator.measure(
      liveDeps({ [A]: run(A, OPEN), [B]: run(B, OPEN) }, { onMeasure: (a) => measured.push(a) }),
      { underlyingKey: UNDERLYING, direction: 'buy', requestedCashAtomic: '100000000' },
    );
    assert.deepEqual(measured, [], 'asking the router again would buy what we hold');
    assert.deepEqual(result.reusedOpen.sort(), [A, B].sort());
  });

  test('a never-measured representation is measured', async () => {
    const measured: string[] = [];
    const coordinator = createMarketRealityCoordinatorV1({ now: () => NOW });
    await coordinator.measure(liveDeps({}, { onMeasure: (a) => measured.push(a) }), {
      underlyingKey: UNDERLYING,
      direction: 'buy',
      requestedCashAtomic: '100000000',
    });
    assert.deepEqual(measured.sort(), [A, B].sort());
  });

  test('the answer is re-read from storage, never patched in memory', async () => {
    // The read path is the only thing allowed to decide what counts as current.
    // A live answer that took a shortcut would be a second definition of
    // freshness, free to disagree with the first.
    const coordinator = createMarketRealityCoordinatorV1({ now: () => NOW });
    const deps = liveDeps({ [A]: run(A, LAPSED), [B]: run(B, LAPSED) });
    const result = await coordinator.measure(deps, {
      underlyingKey: UNDERLYING,
      direction: 'buy',
      requestedCashAtomic: '100000000',
    });
    const readAgain = await assembleMarketRealityV1(deps, {
      underlyingKey: UNDERLYING,
      direction: 'buy',
      requestedCashAtomic: '100000000',
    });
    assert.deepEqual(
      result.answer.representations.map((row) => [row.tokenAddress, row.status, row.liveness]),
      readAgain.representations.map((row) => [row.tokenAddress, row.status, row.liveness]),
    );
  });

  test('a token the chain would not describe is unresolved, and accused of nothing', async () => {
    const coordinator = createMarketRealityCoordinatorV1({ now: () => NOW });
    const result = await coordinator.measure(
      liveDeps({}, { resolveFails: new Set([A]) }),
      { underlyingKey: UNDERLYING, direction: 'buy', requestedCashAtomic: '100000000' },
    );
    assert.deepEqual(result.unresolved, [
      { tokenAddress: A, reason: 'token_decimals_unavailable' },
    ]);
    assert.deepEqual(result.measured, [B], 'the other representation is still measured');
  });
});

describe('deduplication', () => {
  test('concurrent callers of the same question share one measurement', async () => {
    // Ten readers opening NVIDIA at $1k in the same second must cost one
    // measurement, not ten.
    let calls = 0;
    const coordinator = createMarketRealityCoordinatorV1({ now: () => NOW });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps: MarketRealityLiveDepsV1 = {
      ...liveDeps({}),
      measureOne: async ({ token }) => {
        calls += 1;
        await gate;
        return run(token.tokenAddress, OPEN);
      },
    };
    const ask = () =>
      coordinator.measure(deps, {
        underlyingKey: UNDERLYING,
        direction: 'buy',
        requestedCashAtomic: '100000000',
      });
    const all = Promise.all([ask(), ask(), ask()]);
    assert.equal(coordinator.inFlightCount(), 1, 'one question, one flight');
    release();
    const results = await all;
    assert.equal(calls, 2, 'two representations, measured once each');
    assert.equal(results.filter((row) => row.joinedInFlight).length, 2);
    assert.equal(results.filter((row) => !row.joinedInFlight).length, 1);
  });

  test('a different question is not deduplicated onto this one', async () => {
    let calls = 0;
    const coordinator = createMarketRealityCoordinatorV1({ now: () => NOW });
    const deps: MarketRealityLiveDepsV1 = {
      ...liveDeps({}),
      measureOne: async ({ token }) => {
        calls += 1;
        return run(token.tokenAddress, OPEN);
      },
    };
    await coordinator.measure(deps, {
      underlyingKey: UNDERLYING,
      direction: 'buy',
      requestedCashAtomic: '100000000',
    });
    await coordinator.measure(deps, {
      underlyingKey: UNDERLYING,
      direction: 'buy',
      requestedCashAtomic: '10000000000',
    });
    assert.equal(calls, 4, 'two representations, two distinct sizes');
  });

  test('the in-flight slot is released even when a measurement throws', async () => {
    // A slot nobody releases is a security that can never be measured again.
    const coordinator = createMarketRealityCoordinatorV1({ now: () => NOW });
    const deps: MarketRealityLiveDepsV1 = {
      ...liveDeps({}),
      measureOne: async () => {
        throw new Error('router exploded');
      },
    };
    await assert.rejects(() =>
      coordinator.measure(deps, {
        underlyingKey: UNDERLYING,
        direction: 'buy',
        requestedCashAtomic: '100000000',
      }),
    );
    assert.equal(coordinator.inFlightCount(), 0);
  });

  test('the cooldown stops a refreshing page from becoming the sampler', async () => {
    // Quotes expire in twenty seconds. Without a cooldown, a page on a timer
    // re-measures every representation every twenty seconds forever — which is
    // exactly the background load this whole path exists to avoid.
    let calls = 0;
    let clock = NOW.getTime();
    const coordinator = createMarketRealityCoordinatorV1({
      now: () => new Date(clock),
      cooldownMs: 20_000,
    });
    const deps: MarketRealityLiveDepsV1 = {
      ...liveDeps({}),
      // Storage never gets fresher, so every pass sees stale evidence and only
      // the cooldown can stop the second call.
      measureOne: async ({ token }) => {
        calls += 1;
        return run(token.tokenAddress, LAPSED);
      },
    };
    const ask = () =>
      coordinator.measure(deps, {
        underlyingKey: UNDERLYING,
        direction: 'buy',
        requestedCashAtomic: '100000000',
      });
    await ask();
    assert.equal(calls, 2);
    const second = await ask();
    assert.equal(calls, 2, 'nothing re-measured inside the cooldown');
    assert.deepEqual(second.reusedCooldown.sort(), [A, B].sort());

    clock += 21_000;
    await ask();
    assert.equal(calls, 4, 'and measured again once it lapses');
  });
});
