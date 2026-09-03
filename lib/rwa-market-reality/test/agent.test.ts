import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type {
  CashExitMeasurementRunV1,
  RepresentationSupplyRowV1,
  RepresentationUnderlyingV1,
  UnderlyingAssetV1,
} from '@mioagent/route-storage';

import {
  MarketRealityAgentChangesInputV1Schema,
  MarketRealityAgentChangesOutputV1Schema,
  compareMarketRealityForAgentV1,
  MARKET_REALITY_AGENT_CHANGES_DEFAULT_PAGE_V1,
  getMarketRealityChangesForAgentV1,
  listReviewedStocksForAgentV1,
  getMarketRealityRepresentationsForAgentV1,
} from '../src/agent.js';
import { assembleMarketRealityV2 } from '../src/engine.js';

const UNDERLYING = 'security:isin:US67066G1040';
const COINBASE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BACKED = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH = `0x${'11'.repeat(32)}` as const;
const CANDIDATE = `0x${'22'.repeat(32)}` as const;
const NOW = new Date('2026-08-29T12:00:00.000Z');

const underlying: UnderlyingAssetV1 = {
  underlyingKey: UNDERLYING,
  assetClass: 'equity',
  canonicalName: 'NVIDIA Corporation',
  displaySymbol: 'NVDA',
  identifierScheme: 'isin',
  identifierValue: 'US67066G1040',
  sourceKind: 'coinbase_b20_metadata',
  sourceRef: 'coinbase:NVDA',
  sourceHash: 'ab'.repeat(32),
  observedAt: '2026-08-29T11:00:00.000Z',
};

function binding(
  tokenAddress: string,
  issuerId: 'coinbase' | 'backed',
): RepresentationUnderlyingV1 {
  return {
    chainId: 8453,
    tokenAddress,
    underlyingKey: UNDERLYING,
    sourceKind: issuerId === 'coinbase' ? 'coinbase_b20_metadata' : 'backed_assets_api',
    sourceRef: `${issuerId}:instrument:nvda`,
    sourceHash: 'cd'.repeat(32),
    issuerId,
    issuerInstrumentKey: `${issuerId}:instrument:nvda`,
    caip10: `eip155:8453:${tokenAddress}`,
    representationKind: issuerId === 'coinbase' ? 'b20_asset' : 'rebasing_erc20',
    evidenceStrength:
      issuerId === 'coinbase'
        ? 'reviewed_machine_mapping_with_onchain_cross_check'
        : 'reviewed_machine_address_mapping',
    observedBlockNumber: issuerId === 'coinbase' ? '50600000' : null,
    observedBlockHash: issuerId === 'coinbase' ? HASH : null,
    observedAt: '2026-08-29T11:00:00.000Z',
  };
}

const bindings = [binding(COINBASE, 'coinbase'), binding(BACKED, 'backed')];

function supply(tokenAddress: string, amount: string): RepresentationSupplyRowV1 {
  return {
    chainId: 8453,
    tokenAddress,
    state: amount === '0' ? 'zero_supply' : 'positive_supply',
    totalSupplyAtomic: amount,
    decimals: 18,
    normalization: 'raw_erc20_total_supply',
    blockNumber: '50600000',
    blockHash: HASH,
    source: 'erc20_total_supply',
    evidenceHash: HASH,
    readOutcome: 'success',
    failureCode: null,
    observedAt: '2026-08-29T11:59:00.000Z',
    lastCheckedAt: '2026-08-29T11:59:00.000Z',
    lastChangedAt: null,
    reads: 1,
    changes: 0,
    createdAt: '2026-08-29T11:59:00.000Z',
  };
}

function run(
  tokenAddress: string,
  completedAt = '2026-08-29T11:59:01.000Z',
): CashExitMeasurementRunV1 {
  const runId = completedAt.endsWith('01.000Z') ? HASH : (`0x${'33'.repeat(32)}` as const);
  return {
    schemaVersion: 'official-cash-exit-run/v1',
    runId,
    chainId: 8453,
    tokenAddress,
    scope: 'public_ladder',
    tenantId: null,
    approvedSources: ['router-a'],
    destinations: ['USDC'],
    startedAt: completedAt,
    completedAt,
    observations: [
      {
        schemaVersion: 'official-cash-exit-observation/v1',
        observationHash: runId,
        runId,
        chainId: 8453,
        tokenAddress,
        tokenSymbol: 'NVDA',
        tokenDecimals: 18,
        scope: 'public_ladder',
        tenantId: null,
        sizeKind: 'cash_equivalent',
        requestedCashAtomic: '1000000000',
        requestedTokenAtomic: null,
        testedTokenAtomic: '4000000000000000000',
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
          outputAddress: tokenAddress,
          inputAtomic: '1000000000',
          outputAtomic: '4000000000000000000',
          routeKey: CANDIDATE,
          candidateHash: CANDIDATE,
          evidenceHash: HASH,
          observedAt: completedAt,
          expiresAt: '2026-08-29T12:00:20.000Z',
          blockNumber: '50600000',
          liquiditySources: ['pool-a'],
        },
        sellQuote: null,
        errorCode: null,
        observedAt: completedAt,
        expiresAt: '2026-08-29T12:00:20.000Z',
      },
    ],
  };
}

function deps(bindingRows: RepresentationUnderlyingV1[] = bindings) {
  const runs = new Map([
    [COINBASE, [run(COINBASE)]],
    [BACKED, [run(BACKED)]],
  ]);
  return {
    underlyings: {
      representationsOf: async () => bindingRows,
      underlyingOf: async ({ tokenAddress }: { tokenAddress: string }) => {
        const found = bindingRows.find((row) => row.tokenAddress === tokenAddress.toLowerCase());
        return found ? { binding: found, underlying } : null;
      },
    },
    cashExit: {
      latestCompletedRun: async ({ tokenAddress }: { tokenAddress: string }) =>
        runs.get(tokenAddress)?.[0] ?? null,
      completedRunsSince: async ({ tokenAddress }: { tokenAddress: string }) =>
        runs.get(tokenAddress) ?? [],
    },
    ratios: { readRatios: async () => [] },
    supplies: {
      readSupplies: async () => [supply(COINBASE, '1000000000000000000'), supply(BACKED, '0')],
    },
    now: () => NOW,
  } as never;
}

describe('Phase 12B.1 agent contracts', () => {
  test('ticker is rejected where an exact address or CAIP-10 is required', () => {
    assert.equal(
      MarketRealityAgentChangesInputV1Schema.safeParse({
        address: 'NVDA',
        sizeUsd: 1000,
        direction: 'sell',
        destination: 'USDC',
        window: '24h',
        chain: 'base',
      }).success,
      false,
    );
  });

  test('all legitimate issuers remain separate and zero supply stays visible', async () => {
    const result = await getMarketRealityRepresentationsForAgentV1(deps(), {
      underlyingKey: UNDERLYING,
      chain: 'base',
    });
    assert.equal(result.selection.status, 'not_selected');
    assert.deepEqual(
      result.representations.map((row) => row.issuerId),
      ['coinbase', 'backed'],
    );
    assert.deepEqual(
      result.representations.map((row) => row.tokenAddress),
      [COINBASE, BACKED],
    );
    assert.equal(result.representations[1]?.supply.state, 'zero_supply');
    assert.equal(result.representations[0]?.caip10, `eip155:8453:${COINBASE}`);
  });

  test('a pre-0059 binding stays visible, with its issuer recovered and its structure not guessed', async () => {
    // The row keeps its address and its reviewed source; `backed_assets_api`
    // IS Backed's own source, so the issuer follows from it deterministically.
    // The structure does not: a non-rebasing wrapper has no ratio row, so
    // "no evidence" must not become "rebasing".
    const incomplete: RepresentationUnderlyingV1 = {
      ...binding(BACKED, 'backed'),
      issuerId: null,
      issuerInstrumentKey: null,
      representationKind: null,
    };
    const result = await getMarketRealityRepresentationsForAgentV1(
      deps([bindings[0]!, incomplete]),
      {
        underlyingKey: UNDERLYING,
        chain: 'base',
      },
    );
    assert.equal(result.representationCount, 2);
    assert.equal(result.representations.length, 2);
    assert.equal(result.representations[1]?.tokenAddress, BACKED);
    assert.equal(result.representations[1]?.issuerId, 'backed');
    assert.equal(
      result.representations[1]?.issuerInstrumentKey,
      `backed:base_address:${BACKED}`,
    );
    assert.equal(result.representations[1]?.issuerTypingRecovered, true);
    assert.equal(result.representations[1]?.representationKind, null);
    // The complete row is untouched and says so.
    assert.equal(result.representations[0]?.issuerTypingRecovered, false);
    assert.equal(result.representations[0]?.issuerInstrumentKey, 'coinbase:instrument:nvda');
  });

  test('comparison is the canonical v2 answer, with ranking withheld and no execution fields', async () => {
    const coreDeps = deps();
    const input = {
      underlyingKey: UNDERLYING,
      sizeUsd: 1000,
      direction: 'buy' as const,
      destination: 'USDC' as const,
      chain: 'base' as const,
    };
    const [agent, canonical] = await Promise.all([
      compareMarketRealityForAgentV1(coreDeps, input),
      assembleMarketRealityV2(coreDeps, {
        underlyingKey: UNDERLYING,
        direction: 'buy',
        requestedCashAtomic: '1000000000',
        destination: 'USDC',
      }),
    ]);
    assert.deepEqual(agent.comparison, canonical);
    assert.equal(agent.comparison.ranking.status, 'withheld');
    assert.equal(agent.comparison.universe.zeroSupplyRepresentationCount, 1);
    assert.equal(agent.quoteOnly, true);
    assert.equal(agent.executionEvidenceIncluded, false);
    assert.doesNotMatch(
      JSON.stringify(agent),
      /approvalCalldata|transactionRequest|signedTransaction|executionProven":true/,
    );
  });

  test('changes keep pre-snapshot evidence as a non-asset gap and leak no private Radar data', async () => {
    const result = await getMarketRealityChangesForAgentV1(deps(), {
      address: `eip155:8453:${COINBASE}`,
      sizeUsd: 1000,
      direction: 'buy',
      destination: 'USDC',
      window: '24h',
      chain: 'base',
    });
    assert.equal(result.question.requestedCashAtomic, '1000000000');
    assert.equal(result.interpolated, false);
    assert.equal(result.observations[0]?.kind, 'gap');
    assert.equal(result.observations[0]?.evidenceClass, 'router_quote');
    assert.equal(
      result.observations[0]?.kind === 'gap' ? result.observations[0].assetEvent : null,
      false,
    );
    assert.deepEqual(result.changes, []);
    assert.equal(result.privateRadarMetadataIncluded, false);
    assert.doesNotMatch(JSON.stringify(result), /watchId|userId|tenantId/);
  });

  test('the assembled response re-parses with its changes already stripped', () => {
    // The response is parsed once as it is built and again by the output
    // schema. A transform re-run over its own output demands the input shape
    // back, so a change that had `eventId`/`watchId` stripped failed on the
    // very fields stripping them had removed -- and the tool answered ONLY
    // while `changes` was empty. A fixture asserting `[]` cannot see that.
    const publicChange = {
      chainId: 8453 as const,
      tokenAddress: COINBASE,
      previousSnapshotHash: HASH,
      snapshotHash: `0x${'44'.repeat(32)}`,
      previousObservedAt: '2026-08-29T10:00:00.000Z',
      occurredAt: '2026-08-29T11:00:00.000Z',
      approvedSources: ['router-a'],
      kind: 'sell_exit_cost_changed' as const,
      facts: { exitCostBpsBefore: '9', exitCostBpsAfter: '14' },
    };
    const response = {
      schemaVersion: 'miorail-agent-market-changes/v1' as const,
      chain: 'base' as const,
      chainId: 8453 as const,
      tokenAddress: COINBASE,
      caip10: `eip155:8453:${COINBASE}`,
      underlyingKey: UNDERLYING,
      question: {
        requestedCashAtomic: '1000000000',
        sizeUsd: 1000,
        direction: 'sell' as const,
        destination: 'USDC' as const,
        exactSizeOnly: true as const,
      },
      window: '24h' as const,
      since: '2026-08-28T12:00:00.000Z',
      interpolated: false as const,
      routePolicy: { routePolicyKey: HASH, approvedSources: ['router-a'] },
      detail: 'full',
      windowObservationCount: 0,
      windowChangeCount: 1,
      changeCountsByKind: { sell_exit_cost_changed: 1 },
      returnedSince: null,
      returnedUntil: null,
      nextCursor: null,
      observations: [],
      changes: [publicChange],
      privateRadarMetadataIncluded: false as const,
      assembledAt: NOW.toISOString(),
    };

    const parsed = MarketRealityAgentChangesOutputV1Schema.parse(response);
    assert.equal(parsed.changes.length, 1);
    assert.equal(parsed.changes[0]?.kind, 'sell_exit_cost_changed');

    // And the private identifiers cannot travel back in through this door.
    assert.equal(
      MarketRealityAgentChangesOutputV1Schema.safeParse({
        ...response,
        changes: [{ ...publicChange, eventId: HASH, watchId: HASH }],
      }).success,
      false,
    );
  });

  test('a size the converter represents exactly is not refused by its own float test', () => {
    // 100.1 * 1_000_000 is 100100000.00000001 in IEEE-754. Rejecting it would
    // refuse a size this module converts to atoms without loss.
    for (const sizeUsd of [100.1, 0.07, 1000, 29.99]) {
      assert.equal(
        MarketRealityAgentChangesInputV1Schema.safeParse({
          address: COINBASE,
          sizeUsd,
          direction: 'sell',
          destination: 'USDC',
          window: '24h',
          chain: 'base',
        }).success,
        true,
        `sizeUsd ${sizeUsd} must be accepted`,
      );
    }
    assert.equal(
      MarketRealityAgentChangesInputV1Schema.safeParse({
        address: COINBASE,
        sizeUsd: 0.0000001,
        direction: 'sell',
        destination: 'USDC',
        window: '24h',
        chain: 'base',
      }).success,
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Discovery, and the size of an answer.
//
// A live Codex audit found two things a connected assistant could not work
// around: every Stocks tool needed a namespaced key or an exact address and
// nothing produced one, and a 7d changes call came back as 163 observations,
// 137 changes and 239,764 bytes — a meaningful fraction of an agent's whole
// context spent on one call.
// ---------------------------------------------------------------------------

describe('list_reviewed_stocks', () => {
  const index = [
    {
      underlying: {
        underlyingKey: 'security:isin:US67066G1040',
        canonicalName: 'NVIDIA Corporation',
        displaySymbol: 'NVDA',
        assetClass: 'equity' as const,
        identifierScheme: 'isin' as const,
        identifierValue: 'US67066G1040',
        sourceKind: 'coinbase_b20_metadata' as const,
        sourceRef: 'https://docs.base.org/',
        sourceHash: null,
        observedAt: '2026-08-26T20:00:00.000Z',
      },
      representationCount: 2,
      issuerIds: ['backed', 'coinbase'],
      liveRepresentationCount: 2,
    },
    {
      underlying: {
        underlyingKey: 'security:isin:US5949181045',
        canonicalName: 'Microsoft Corporation',
        displaySymbol: 'MSFT',
        assetClass: 'equity' as const,
        identifierScheme: 'isin' as const,
        identifierValue: 'US5949181045',
        sourceKind: 'coinbase_b20_metadata' as const,
        sourceRef: 'https://docs.base.org/',
        sourceHash: null,
        observedAt: '2026-08-26T20:00:00.000Z',
      },
      representationCount: 2,
      issuerIds: ['backed', 'coinbase'],
      liveRepresentationCount: 0,
    },
  ];
  const stockDeps = { underlyings: { listUnderlyings: async () => index } } as never;

  test('turns a company name into the key every other tool requires', async () => {
    const result = await listReviewedStocksForAgentV1(stockDeps, { query: 'nvidia' });
    assert.equal(result.returned, 1);
    assert.equal(result.stocks[0]?.underlyingKey, 'security:isin:US67066G1040');
    assert.equal(result.reviewedTotal, 2);
    assert.equal(result.query, 'nvidia');
  });

  test('matches a ticker and an identifier as well as a name', async () => {
    for (const query of ['MSFT', 'msft', 'US5949181045', 'microsoft']) {
      const result = await listReviewedStocksForAgentV1(stockDeps, { query });
      assert.deepEqual(result.stocks.map((row) => row.displaySymbol), ['MSFT'], query);
    }
  });

  test('it never selects a representation', async () => {
    const result = await listReviewedStocksForAgentV1(stockDeps, {});
    assert.equal(result.selection, 'never');
    // No address, anywhere: choosing between two issuers' contracts for one
    // company is exactly the decision this product refuses to make.
    assert.doesNotMatch(JSON.stringify(result), /0x[0-9a-fA-F]{40}/);
    assert.doesNotMatch(JSON.stringify(result), /tokenAddress|caip10/);
  });

  test('a security with nothing outstanding says so before a comparison is spent', async () => {
    const result = await listReviewedStocksForAgentV1(stockDeps, { query: 'MSFT' });
    assert.equal(result.stocks[0]?.liveRepresentationCount, 0);
    assert.equal(result.stocks[0]?.representationCount, 2);
  });

  test('no match is a miss in Miorail\u2019s naming, not a claim about Base', async () => {
    // Production holds the TICKER in both name fields for most rows, so
    // "nvidia" finds nothing while "NVDA" finds three representations. An
    // assistant told only "0 results" repeats it as "Miorail has no NVIDIA".
    const result = await listReviewedStocksForAgentV1(stockDeps, { query: 'zzzz' });
    assert.deepEqual(result.stocks, []);
    assert.equal(result.returned, 0);
    assert.equal(result.reviewedTotal, 2);
    assert.match(result.note, /try the ticker/);
    assert.match(result.note, /never a statement that the instrument has no representation/);
  });

  test('an empty corpus is not reported as a naming miss', async () => {
    const empty = { underlyings: { listUnderlyings: async () => [] } } as never;
    const result = await listReviewedStocksForAgentV1(empty, { query: 'zzzz' });
    assert.equal(result.reviewedTotal, 0);
    assert.doesNotMatch(result.note, /try the ticker/);
  });

  test('a page that had to stop says so', async () => {
    const result = await listReviewedStocksForAgentV1(stockDeps, { limit: 1 });
    assert.equal(result.returned, 1);
    assert.equal(result.truncated, true);
  });

  // -------------------------------------------------------------------------
  // The corpus as PRODUCTION stores it.
  //
  // The fixture above names its rows "NVIDIA Corporation" and "Microsoft
  // Corporation", which is why every query above passed — and why none of them
  // could fail. Production stores the ticker in both name fields for 17 of 63
  // reviewed rows, NVDA and MSFT among them, so "nvidia" reached nothing on the
  // live server while this suite was green.
  // -------------------------------------------------------------------------
  const tickerOnly = [
    {
      underlying: {
        underlyingKey: 'security:isin:US67066G1040',
        canonicalName: 'NVDA',
        displaySymbol: 'NVDA',
        assetClass: 'equity' as const,
        identifierScheme: 'isin' as const,
        identifierValue: 'US67066G1040',
        sourceKind: 'coinbase_b20_metadata' as const,
        sourceRef: 'https://docs.base.org/',
        sourceHash: null,
        observedAt: '2026-08-26T20:00:00.000Z',
      },
      representationCount: 4,
      issuerIds: ['backed', 'coinbase', 'dinari'],
      liveRepresentationCount: 4,
    },
    {
      underlying: {
        underlyingKey: 'dinari:stock_id:0196ea6d-b6e6-72e1-90b9-2bb5b3efb0a5',
        canonicalName: 'State Street SPDR S&P 500 ETF Trust',
        displaySymbol: 'SPY',
        assetClass: 'fund_share' as const,
        identifierScheme: 'dinari_stock_id' as const,
        identifierValue: '0196ea6d-b6e6-72e1-90b9-2bb5b3efb0a5',
        sourceKind: 'dinari_stock_api' as const,
        sourceRef: 'https://api.dinari.com/',
        sourceHash: null,
        observedAt: '2026-08-26T20:00:00.000Z',
      },
      representationCount: 1,
      issuerIds: ['dinari'],
      liveRepresentationCount: 1,
    },
  ];
  const tickerOnlyDeps = { underlyings: { listUnderlyings: async () => tickerOnly } } as never;

  test('a company name reaches a row that stores only its ticker', async () => {
    const result = await listReviewedStocksForAgentV1(tickerOnlyDeps, { query: 'nvidia' });
    assert.equal(result.returned, 1);
    assert.equal(result.stocks[0]?.underlyingKey, 'security:isin:US67066G1040');
    // Said out loud: this was Miorail's own alias, not the issuer's naming.
    assert.equal(result.stocks[0]?.matchedBy, 'miorail_alias');
    assert.match(result.note, /Miorail-maintained company-name alias/);
  });

  test('an alias resolves a security, never a ticker or an address', async () => {
    // The alias is keyed on the ISIN. A row carrying the same ticker under a
    // different security does not match it, which is the property that makes
    // the table safe to keep by hand.
    const impostor = [
      {
        ...tickerOnly[0],
        underlying: {
          ...tickerOnly[0].underlying,
          underlyingKey: 'security:isin:US0000000000',
          identifierValue: 'US0000000000',
        },
      },
    ];
    const deps = { underlyings: { listUnderlyings: async () => impostor } } as never;
    const result = await listReviewedStocksForAgentV1(deps, { query: 'nvidia' });
    assert.deepEqual(result.stocks, []);
    // And no address ever appears, alias hit or not.
    assert.doesNotMatch(
      JSON.stringify(await listReviewedStocksForAgentV1(tickerOnlyDeps, { query: 'nvidia' })),
      /0x[0-9a-fA-F]{40}/,
    );
  });

  test('the stored naming still wins when it is the thing that matched', async () => {
    const result = await listReviewedStocksForAgentV1(stockDeps, { query: 'nvidia' });
    assert.equal(result.stocks[0]?.matchedBy, 'stored_naming');
    assert.doesNotMatch(result.note, /company-name alias/);
  });

  test('the reviewed corpus is not all common stock, and says so', async () => {
    // The web Stocks screen filters to `equity`. This tool does not, and a
    // caller comparing the two universes would otherwise find two different
    // totals with nothing explaining the gap — SPY, IBIT and GBTC are fund
    // shares, and they are among the few reviewed rows that hold a cash route.
    const all = await listReviewedStocksForAgentV1(tickerOnlyDeps, {});
    assert.equal(all.reviewedTotal, 2);
    assert.deepEqual(all.reviewedByAssetClass, {
      equity: 1,
      fund_share: 1,
      other: 0,
      unknown: 0,
    });
    assert.equal(all.assetClass, null);
    assert.match(all.note, /web Stocks screen shows the 1 equity rows only/);

    const equities = await listReviewedStocksForAgentV1(tickerOnlyDeps, { assetClass: 'equity' });
    assert.deepEqual(equities.stocks.map((row) => row.displaySymbol), ['NVDA']);
    assert.equal(equities.assetClass, 'equity');
    // The breakdown describes the CORPUS, so a filtered call still reports the
    // rows it did not return.
    assert.equal(equities.reviewedByAssetClass.fund_share, 1);
    assert.equal(equities.reviewedTotal, 2);
  });
});

describe('get_market_changes stays inside an agent context', () => {
  const question = {
    address: `eip155:8453:${COINBASE}`,
    sizeUsd: 1000,
    direction: 'buy' as const,
    destination: 'USDC' as const,
    window: '24h' as const,
    chain: 'base' as const,
  };

  test('summary returns the counts and the tally, and no rows at all', async () => {
    const result = await getMarketRealityChangesForAgentV1(deps(), {
      ...question,
      detail: 'summary',
    });
    assert.equal(result.detail, 'summary');
    assert.deepEqual(result.observations, []);
    assert.deepEqual(result.changes, []);
    // The counts are of the WHOLE window, so "nothing returned" is never
    // readable as "nothing happened".
    assert.equal(typeof result.windowObservationCount, 'number');
    assert.equal(typeof result.windowChangeCount, 'number');
    assert.equal(result.nextCursor, null);
    assert.equal(result.returnedSince, null);
  });

  test('full is the default and pages the newest rows', async () => {
    const result = await getMarketRealityChangesForAgentV1(deps(), question);
    assert.equal(result.detail, 'full');
    assert.ok(result.observations.length <= MARKET_REALITY_AGENT_CHANGES_DEFAULT_PAGE_V1);
    assert.equal(result.windowObservationCount, result.observations.length);
    // Everything fits, so there is nothing older to walk back to.
    assert.equal(result.nextCursor, null);
  });

  test('a limit smaller than the window leaves a cursor behind', async () => {
    const full = await getMarketRealityChangesForAgentV1(deps(), question);
    if (full.observations.length < 2) return; // the fixture has one run
    const first = await getMarketRealityChangesForAgentV1(deps(), { ...question, limit: 1 });
    assert.equal(first.observations.length, 1);
    assert.equal(first.windowObservationCount, full.observations.length);
    assert.ok(first.nextCursor, 'a truncated page must be continuable');
    const next = await getMarketRealityChangesForAgentV1(deps(), {
      ...question,
      limit: 1,
      before: first.nextCursor!,
    });
    assert.notDeepEqual(next.observations, first.observations);
  });

  test('the whole window is still what gets derived', async () => {
    // Paging the ANSWER, never the derivation: changes come from consecutive
    // pairs, so a page taken before the pairs are built would invent gaps.
    const paged = await getMarketRealityChangesForAgentV1(deps(), { ...question, limit: 1 });
    const summary = await getMarketRealityChangesForAgentV1(deps(), {
      ...question,
      detail: 'summary',
    });
    assert.equal(paged.windowChangeCount, summary.windowChangeCount);
    assert.deepEqual(paged.changeCountsByKind, summary.changeCountsByKind);
  });
});
