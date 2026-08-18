import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  createMiorailMcpServerV1,
  MIORAIL_MCP_INSTRUCTIONS_V1,
  MIORAIL_MCP_VERSION_V1,
} from './server.js';
import { b20RouteRuntime, readDiscoverFeedV1 } from '../b20Control.js';
import { compareNothingToCompareReasonV1 } from './tools.js';

// ---------------------------------------------------------------------------
// T72 §8 — driven through a REAL MCP client over a real transport.
//
// Calling the tool functions directly would test the projection and skip the
// protocol, which is where the things a client actually depends on live: tool
// discovery, schema validation of arguments, and the shape of an error. All of
// those are the SDK's job, and the way to find out whether we used it correctly
// is to speak to it the way Claude, ChatGPT and Codex will.
//
// The other half is §5. This surface is public and unauthenticated, so the
// tests that matter most are the ones asserting what it CANNOT do.
// ---------------------------------------------------------------------------

// `__dirname`, not `import.meta.url` (this package compiles to CommonJS, where
// that meta-property is a compile error) and not `process.cwd()` (the test
// runner sets cwd per package, so a repo-root-relative path silently resolved
// to nothing — and `readdirSync` throwing inside a describe body drops its
// tests without failing anything).
const here = __dirname;

const LAUNCH = {
  id: `0x${'cd'.repeat(32)}:0`,
  tokenAddress: '0xb200000000000000000000d6f666fe8b27595c01',
  name: 'o1 mascot',
  symbol: 'DINo1',
  variant: 'asset' as const,
  decimals: 18,
  blockNumber: '49531000',
  transactionHash: `0x${'cd'.repeat(32)}`,
  logIndex: 0,
  detectedAt: '2026-08-05T11:42:00.000Z',
  blockTimestamp: null,
  canonical: true,
};

function observation(overrides: Record<string, unknown> = {}) {
  return {
    state: 'provisional' as const,
    reasonCode: 'quoted_pre_entry',
    referencePositionAtomic: '100000000',
    referenceQuoteAsset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    maxRoundTripBps: 300,
    maxExitSlippageBps: 300,
    entryRouteFound: true,
    exitRouteFound: true,
    entrySourceKey: 'aerodrome|in',
    exitSourceKey: 'aerodrome|out',
    poolHookAddress: '0x985c14baa2a18316ffda0aefb3a632fadfca2acc',
    optimisticExitReturnAtomic: '98700000',
    optimisticRoundTripBps: 130,
    routeCoverage: 'complete' as const,
    viableRouteConfirmed: true,
    bestRouteConfirmed: true,
    largestPassingSizeAtomic: '250000000',
    firstFailingSizeAtomic: '500000000',
    capacityToleranceBps: 300,
    capacityProbeCount: 5,
    capacityStable: true,
    transfersPaused: false,
    transferPolicyState: 'open' as const,
    controlsComplete: true,
    controlsBlockNumber: '49531075',
    observationBlockNumber: '49531075',
    quoteAlignment: 'latest_not_anchored' as const,
    measuredAt: '2026-08-05T11:50:00.000Z',
    staleAfter: '2026-08-05T12:20:00.000Z',
    ...overrides,
  };
}

type StubFeedRowV1 = {
  launch: typeof LAUNCH;
  observation: unknown;
  launchBuyers?: {
    buyerCount: number;
    topBuyerShareBps: number | null;
    topThreeShareBps: number | null;
    fromBlock: string;
    toBlock: string;
  } | null;
};

const LAUNCH_BUYERS = {
  buyerCount: 76,
  topBuyerShareBps: 1_482,
  topThreeShareBps: 2_973,
  fromBlock: LAUNCH.blockNumber,
  toBlock: '49541000',
};

const MEASURED_ROW: StubFeedRowV1 = {
  launch: LAUNCH,
  observation: observation(),
  launchBuyers: LAUNCH_BUYERS,
};

/** A stub repository: the tools are exercised, the database is not. */
function stubObservations(rows: StubFeedRowV1[]) {
  return {
    listFeed: async () => ({ rows, nextCursor: null }),
    // `miorail_get_b20_opportunity` reads by address DIRECTLY now, rather than
    // searching the newest page — which is the whole point of the fix, and the
    // reason this fake has to answer the same question the feed does.
    getFeedRowForToken: async ({ tokenAddress }: { tokenAddress: string }) => {
      const row = rows.find(
        (entry) => entry.launch.tokenAddress.toLowerCase() === tokenAddress.toLowerCase(),
      );
      return row ? { row, history: row.observation ? [row.observation] : [] } : null;
    },
    listMoverPairs: async () => [],
    pipelineCounts: async () => ({
      ingestionCursorBlock: '49531000',
      lastIngestionConfirmedHead: '49531010',
      lastIngestionRunAt: '2026-08-05T11:40:00.000Z',
      lastIngestionResult: 'success',
      lastMeasurementRunAt: '2026-08-05T11:50:00.000Z',
      canonicalLaunchCount: rows.length,
      launchesAwaitingMeasurement: 0,
      observationCount: rows.filter((row) => row.observation).length,
      lastIngestionBudgetExhausted: false,
      ingestionOperatorState: null,
    }),
  } as never;
}

const original = {
  observations: b20RouteRuntime.observations,
  discoverAvailable: b20RouteRuntime.discoverAvailable,
  now: b20RouteRuntime.now,
  projectsAvailable: b20RouteRuntime.projectsAvailable,
  reader: b20RouteRuntime.reader,
};

before(() => {
  b20RouteRuntime.observations = () => stubObservations([MEASURED_ROW]);
  b20RouteRuntime.discoverAvailable = async () => true;
  // Compare reads several tokens the way the console does. Two of the runtime's
  // accessors are on that path and must be stubbed, or a miss reaches the chain:
  // the project layer (absent here, which is `layer_unavailable` rather than
  // "nobody claimed it") and the factory identity read a missing index row
  // triggers.
  b20RouteRuntime.projectsAvailable = async () => false;
  b20RouteRuntime.reader = (() => ({
    readContract: async () => {
      throw new Error('the identity read is not exercised by these tests');
    },
  })) as never;
  b20RouteRuntime.now = () => new Date('2026-08-05T12:00:00.000Z');
});

after(() => {
  b20RouteRuntime.observations = original.observations;
  b20RouteRuntime.discoverAvailable = original.discoverAvailable;
  b20RouteRuntime.projectsAvailable = original.projectsAvailable;
  b20RouteRuntime.reader = original.reader;
  b20RouteRuntime.now = original.now;
});

/** A connected client, over the transport pair the SDK ships for exactly this. */
async function connectedClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMiorailMcpServerV1();
  const client = new Client({ name: 'miorail-test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function payloadOf(result: unknown): Record<string, unknown> {
  const typed = result as {
    structuredContent?: Record<string, unknown>;
    content?: { text?: string }[];
  };
  if (typed.structuredContent) return typed.structuredContent;
  return JSON.parse(typed.content?.[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('§8 — tool discovery', () => {
  test('a client sees exactly the eight tools, with usable descriptions', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      'miorail_b20_market_rails',
      'miorail_compare_b20_tokens',
      'miorail_discover_status',
      'miorail_explain_b20_rejection',
      'miorail_find_b20_projects',
      'miorail_get_b20_opportunity',
      'miorail_list_b20_opportunities',
      'miorail_summarise_b20_universe',
    ]);
    for (const tool of tools) {
      // An assistant chooses from the description alone. A one-liner produces
      // a model that calls the wrong tool and summarises it wrongly.
      assert.ok((tool.description ?? '').length > 120, `${tool.name} has a thin description`);
    }
    await client.close();
  });

  test('the advertised server version is 1.1.0', () => {
    assert.equal(MIORAIL_MCP_VERSION_V1, '1.1.0');
  });

  test('§7 — the server instructions carry all five caveats', async () => {
    // These are what a model reads once, at connection, and what it falls back
    // on when a tool payload is truncated in its context.
    assert.match(MIORAIL_MCP_INSTRUCTIONS_V1, /PROVISIONAL IS NOT QUALIFIED/);
    assert.match(MIORAIL_MCP_INSTRUCTIONS_V1, /NO SUPPORTED ROUTE DOES NOT MEAN NO ROUTE/);
    assert.match(MIORAIL_MCP_INSTRUCTIONS_V1, /EXIT CAPACITY IS MEASURED, NOT INTERPOLATED/);
    assert.match(MIORAIL_MCP_INSTRUCTIONS_V1, /POOL HOOK PERMISSIONS ARE NOT BEHAVIOR/);
    assert.match(MIORAIL_MCP_INSTRUCTIONS_V1, /LAUNCH-WINDOW BUYING IS NOT CURRENT HOLDINGS/);
    assert.match(MIORAIL_MCP_INSTRUCTIONS_V1, /buyers beyond that window/);
    assert.match(MIORAIL_MCP_INSTRUCTIONS_V1, /READ-ONLY/);
  });

  test('the market-rails tool refuses to present itself as a ranking', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const rails = tools.find((tool) => tool.name === 'miorail_b20_market_rails')!;
    assert.match(
      rails.description ?? '',
      /NOT a ranking, a score, a recommendation or a prediction/,
    );
    // Absence from a rail has to be readable as an absence of the NUMBER, not
    // as a finding about the token.
    assert.match(rails.description ?? '', /Absence from a rail is not a negative finding/);
    // A rise in route cost means the exit got more expensive, and the unit is
    // percentage points. Both are said where the agent will read them.
    assert.match(rails.description ?? '', /percentage POINTS/);
    assert.match(rails.description ?? '', /20-28 hours/);
    // `orderBy` is no longer required, because the server returns both rails
    // and the ordering is no longer computed here.
    assert.deepEqual((rails.inputSchema as { required?: string[] }).required ?? [], []);
    await client.close();
  });
});

describe('§4 — every distinction survives the trip', () => {
  test('Discover Card parity survives the list and get projections', async () => {
    const feed = await readDiscoverFeedV1({
      limit: 10,
      cursor: null,
      state: 'all',
      freshness: 'all',
    });
    const expected = feed.cards[0]!;
    const client = await connectedClient();

    // `full` on purpose: the parity anchor IS `discoverCard`, and it is the
    // thing `summary` drops.
    const list = payloadOf(
      await client.callTool({
        name: 'miorail_list_b20_opportunities',
        arguments: { verbosity: 'full' },
      }),
    );
    const get = payloadOf(
      await client.callTool({
        name: 'miorail_get_b20_opportunity',
        arguments: { tokenAddress: LAUNCH.tokenAddress, verbosity: 'full' },
      }),
    );
    // The rails tool is deliberately NOT here any more. It returns the server's
    // own rail rows — the ones the UI rail renders — rather than Discover
    // cards, which is the point of replacing it: one projection, one answer.
    const projected = [
      (list.opportunities as Record<string, unknown>[])[0],
      get.opportunity as Record<string, unknown>,
    ];
    for (const opportunity of projected) {
      assert.deepEqual(opportunity.discoverCard, expected);
      const measurement = opportunity.measurement as Record<string, unknown>;
      assert.deepEqual(
        (measurement.poolHook as Record<string, unknown>).assessment,
        expected.observation?.poolHook,
      );
      assert.deepEqual(
        (measurement.launchBuying as Record<string, unknown>).aggregate,
        expected.observation?.launchBuyers,
      );
      assert.deepEqual(
        (measurement.launchBuying as Record<string, unknown>).window,
        expected.observation?.launchBuyerWindow,
      );
      assert.deepEqual(measurement.routeLiquidity, {
        entrySourceKey: expected.observation?.entrySourceKey,
        exitSourceKey: expected.observation?.exitSourceKey,
        note: 'Provider source keys identify the measured entry and exit routes. A null source means that side was not found on the supported venues.',
      });
    }

    await client.close();
  });

  test('a provisional card arrives labelled provisional, with its pre-entry note', async () => {
    const client = await connectedClient();
    const payload = payloadOf(
      await client.callTool({ name: 'miorail_list_b20_opportunities', arguments: {} }),
    );
    const first = (payload.opportunities as Record<string, unknown>[])[0]!;
    const measurement = first.measurement as Record<string, unknown>;
    assert.equal(measurement.state, 'provisional');
    assert.equal(measurement.freshness, 'fresh');
    assert.equal(measurement.routeCoverage, 'complete');
    assert.equal(measurement.quoteAlignment, 'latest_not_anchored');
    assert.ok(measurement.quoteAlignmentNote, 'the quote-alignment warning was dropped');
    assert.ok(measurement.preEntryNote, 'the pre-entry notice was dropped');
    await client.close();
  });

  test('capacity is a pair of bounds and a warning, never a single figure', async () => {
    const client = await connectedClient();
    const payload = payloadOf(
      await client.callTool({ name: 'miorail_list_b20_opportunities', arguments: {} }),
    );
    const capacity = (
      (payload.opportunities as Record<string, unknown>[])[0]!.measurement as Record<
        string,
        unknown
      >
    ).exitCapacity as Record<string, unknown>;
    assert.equal(capacity.largestPassingSizeAtomic, '250000000');
    assert.equal(capacity.firstFailingSizeAtomic, '500000000');
    assert.match(String(capacity.note), /MEASURED, NOT INTERPOLATED/);
    // There is no field an interpolated figure could occupy.
    assert.ok(!('estimatedCapacityAtomic' in capacity));
    assert.ok(!('capacityAtomic' in capacity));
    await client.close();
  });

  test('an unmeasured number is null and says it is not zero', async () => {
    b20RouteRuntime.observations = () =>
      stubObservations([
        {
          launch: LAUNCH,
          observation: observation({
            optimisticRoundTripBps: null,
            largestPassingSizeAtomic: null,
          }),
        },
      ]);
    const client = await connectedClient();
    const payload = payloadOf(
      await client.callTool({ name: 'miorail_list_b20_opportunities', arguments: {} }),
    );
    const measurement = (payload.opportunities as Record<string, unknown>[])[0]!
      .measurement as Record<string, unknown>;
    const roundTrip = measurement.roundTrip as Record<string, unknown>;
    assert.equal(roundTrip.measuredBps, null);
    assert.match(String(roundTrip.note), /not.*zero, free, or cheap/i);
    b20RouteRuntime.observations = () => stubObservations([MEASURED_ROW]);
    await client.close();
  });

  test('a launch with no block timestamp does not acquire one', async () => {
    const client = await connectedClient();
    const payload = payloadOf(
      await client.callTool({ name: 'miorail_list_b20_opportunities', arguments: {} }),
    );
    const launch = (payload.opportunities as Record<string, unknown>[])[0]!.launch as Record<
      string,
      unknown
    >;
    assert.equal(launch.launchedAt, null);
    assert.equal(launch.launchTimeKnown, false);
    assert.match(String(launch.note), /do not report that block time as a launch time/i);
    await client.close();
  });

  test('the reason vocabulary is typed, and says which findings a wallet cannot change', async () => {
    const client = await connectedClient();
    const payload = payloadOf(
      await client.callTool({
        name: 'miorail_explain_b20_rejection',
        arguments: { reasonCode: 'no_exit_route' },
      }),
    );
    const reason = (payload.reasons as Record<string, unknown>[])[0]!;
    assert.equal(reason.reasonCode, 'no_exit_route');
    assert.equal(reason.dependsOnAskingWallet, false);
    assert.equal(reason.isAJudgementOfTheToken, false);
    assert.match(String(reason.meaning), /not about every venue on Base/);
    await client.close();
  });

  test('an empty feed still explains itself', async () => {
    b20RouteRuntime.discoverAvailable = async () => false;
    const client = await connectedClient();
    const payload = payloadOf(
      await client.callTool({ name: 'miorail_discover_status', arguments: {} }),
    );
    assert.match(String(payload.emptyListMeaning), /does NOT mean the chain is quiet/);
    b20RouteRuntime.discoverAvailable = async () => true;
    await client.close();
  });
});

describe('§8 — malformed input', () => {
  test('a bad address is refused by the schema, before any lookup', async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: 'miorail_get_b20_opportunity',
      arguments: { tokenAddress: 'not-an-address' },
    });
    assert.equal((result as { isError?: boolean }).isError, true);
    await client.close();
  });

  test('an unknown ordering is refused rather than defaulted', async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: 'miorail_b20_market_rails',
      arguments: { orderBy: 'best' },
    });
    assert.equal((result as { isError?: boolean }).isError, true);
    await client.close();
  });

  test('an unknown reason code is refused rather than guessed at', async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: 'miorail_explain_b20_rejection',
      arguments: { reasonCode: 'rug_pull' },
    });
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.match(JSON.stringify(result), /Do not guess what it means/);
    await client.close();
  });

  test('an oversized page is clamped, not honoured', async () => {
    const client = await connectedClient();
    // The schema refuses it outright, which is the stronger of the two bounds.
    const result = await client.callTool({
      name: 'miorail_list_b20_opportunities',
      arguments: { limit: 5000 },
    });
    assert.equal((result as { isError?: boolean }).isError, true);
    await client.close();
  });

  test('an unknown tool is an error, not a silent empty result', async () => {
    const client = await connectedClient();
    const result = await client
      .callTool({ name: 'miorail_execute_trade', arguments: {} })
      .catch(() => 'threw');
    if (result !== 'threw') assert.equal((result as { isError?: boolean }).isError, true);
    await client.close();
  });
});

describe('§5/§8 — what this surface cannot do, and cannot leak', () => {
  const sources = readdirSync(here)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({ name, text: readFileSync(path.join(here, name), 'utf8') }));

  test('the source scan actually found the files it claims to check', () => {
    // Without this, a wrong `here` makes `sources` empty and every assertion
    // below passes vacuously — which is exactly what happened once, and it cost
    // nothing to notice only because the total test count moved.
    assert.deepEqual(sources.map((entry) => entry.name).sort(), [
      'index.ts',
      'server.ts',
      'tools.ts',
    ]);
  });

  test('no signer, submission, clearance or payment reaches these files', () => {
    for (const { name, text } of sources) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      for (const banned of [
        'privateKey',
        'signTransaction',
        'sendCalls',
        'eth_sendRawTransaction',
        'prepareEntry',
        'entryPlans',
        'clearances',
        'x402',
        'walletAddress',
      ]) {
        assert.ok(!code.includes(banned), `${name} reaches ${banned}`);
      }
    }
  });

  test('no tool accepts a wallet address', async () => {
    // Not an omission: an argument the server does not take is a boundary that
    // cannot be crossed by a later edit that "just adds a filter".
    const client = await connectedClient();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const properties = Object.keys(
        (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      );
      for (const property of properties) {
        assert.ok(
          !/wallet|account|owner|holder|signer/i.test(property),
          `${tool.name} accepts ${property}`,
        );
      }
    }
    await client.close();
  });

  test('a failure names no endpoint, credential or connection string', async () => {
    b20RouteRuntime.observations = () => {
      throw new Error('connect ECONNREFUSED postgres://user:hunter2@10.0.0.4:5432/mio');
    };
    const client = await connectedClient();
    const result = await client.callTool({ name: 'miorail_list_b20_opportunities', arguments: {} });
    const text = JSON.stringify(result);
    assert.equal((result as { isError?: boolean }).isError, true);
    for (const secret of ['hunter2', '10.0.0.4', 'postgres://', 'ECONNREFUSED']) {
      assert.ok(!text.includes(secret), `the error leaked ${secret}`);
    }
    b20RouteRuntime.observations = () => stubObservations([MEASURED_ROW]);
    await client.close();
  });

  test('no successful payload carries an internal identifier or a URL', async () => {
    const client = await connectedClient();
    for (const name of ['miorail_discover_status', 'miorail_list_b20_opportunities'] as const) {
      const text = JSON.stringify(payloadOf(await client.callTool({ name, arguments: {} })));
      assert.ok(!/https?:\/\//.test(text), `${name} returned a URL`);
      assert.ok(
        !/apiKey|api_key|secret|password|Bearer /i.test(text),
        `${name} returned a credential`,
      );
    }
    await client.close();
  });

  test('the endpoint is mounted outside the tenant-gated API', () => {
    // An MCP client has no Miorail session. Mounting under /api would put this
    // behind requireTenant and make it unreachable by every client it exists
    // for — and mounting it inside the gate later would break them silently.
    const app = readFileSync(path.join(here, '..', '..', 'app.ts'), 'utf8');
    assert.match(app, /app\.use\('\/mcp', mcpServerRouter\);/);
    assert.ok(
      app.indexOf("app.use('/mcp'") < app.indexOf("app.use('/api', routes)"),
      'the MCP endpoint must mount before the API router',
    );
  });

  test('§3 — the tools read the shared Discover path, not one of their own', () => {
    const tools = sources.find((entry) => entry.name === 'tools.ts')!.text;
    assert.match(tools, /readDiscoverFeedV1/);
    // No direct repository access and no second card projection.
    assert.ok(
      !tools.includes('createDatabaseB20ObservationRepository'),
      'the tools reach the repository directly',
    );
    assert.ok(!tools.includes('b20OpportunityCardV1('), 'the tools build their own cards');
  });
});

// ---------------------------------------------------------------------------
// V2 pass 1 — the three things an agent hit first.
//
//   a by-address read that only saw the newest page;
//   a payload that was 73% duplication;
//   a "leaders" tool that sorted a page inside the MCP while the server had
//   already ranked the same dimension over a much larger window.
// ---------------------------------------------------------------------------
describe('an agent asking by address is not bounded by a page', () => {
  test('a launch outside the newest page still resolves', async () => {
    // The defect: `get` read the newest 25 cards and searched them, so it
    // answered "not in feed" for 33,516 of 33,541 canonical launches — a
    // sentence that sounds like a fact about the token and is a fact about the
    // page size. The stub answers `getFeedRowForToken` and NOT `listFeed` for
    // this address, which is exactly the shape the old code could not read.
    const client = await connectedClient();
    const payload = payloadOf(
      await client.callTool({
        name: 'miorail_get_b20_opportunity',
        arguments: { tokenAddress: LAUNCH.tokenAddress },
      }),
    );
    const opportunity = payload.opportunity as Record<string, unknown>;
    assert.equal((opportunity.token as Record<string, unknown>).address, LAUNCH.tokenAddress);
    // And the bounded history travels with it, so an agent can see whether a
    // second comparable observation exists before asking what changed.
    assert.ok(Array.isArray(payload.history));
    await client.close();
  });

  test('an address with no canonical launch says that about the index', async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: 'miorail_get_b20_opportunity',
      arguments: { tokenAddress: `0x${'c'.repeat(40)}` },
    });
    const text = JSON.stringify(result);
    assert.match(text, /launch_not_found/);
    // Never "this is not a B20 token".
    assert.match(text, /what Miorail has ingested, not about the token/);
    await client.close();
  });
});

describe('the default payload is not mostly duplication', () => {
  test('summary drops the restated card and the per-item caveats', async () => {
    const client = await connectedClient();
    const summary = payloadOf(
      await client.callTool({ name: 'miorail_list_b20_opportunities', arguments: {} }),
    );
    const first = (summary.opportunities as Record<string, unknown>[])[0]!;
    assert.equal(first.discoverCard, undefined);
    assert.equal(first.caveats, undefined);
    // The caveats are still there — once, on the response, where they read as
    // a statement rather than as boilerplate.
    assert.ok(summary.caveats);
    // Everything an agent needs is still projected.
    assert.ok(first.token && first.launch && 'measurement' in first && first.notMeasured);
    await client.close();
  });

  test('full keeps the old shape for a caller that read discoverCard', async () => {
    const client = await connectedClient();
    const full = payloadOf(
      await client.callTool({
        name: 'miorail_list_b20_opportunities',
        arguments: { verbosity: 'full' },
      }),
    );
    const first = (full.opportunities as Record<string, unknown>[])[0]!;
    assert.ok(first.discoverCard);
    assert.ok(first.caveats);
    await client.close();
  });

  test('summary is materially smaller than full', async () => {
    const client = await connectedClient();
    const summary = payloadOf(
      await client.callTool({ name: 'miorail_list_b20_opportunities', arguments: {} }),
    );
    const full = payloadOf(
      await client.callTool({
        name: 'miorail_list_b20_opportunities',
        arguments: { verbosity: 'full' },
      }),
    );
    const bytes = (value: unknown) => JSON.stringify(value).length;
    assert.ok(
      bytes(summary.opportunities) < bytes(full.opportunities) / 2,
      'summary saved less than half, so the duplication is still there',
    );
    await client.close();
  });
});

describe('the market rails are the server’s, not the MCP’s', () => {
  test('the tool no longer sorts anything itself', () => {
    // The old one ran `.sort()` and `BigInt` comparisons in this file, which is
    // how one product came to have two answers to "largest measured exit
    // capacity". The rails projection is the only ranking now.
    const source = readFileSync(path.join(here, 'tools.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.ok(!/\.sort\(/.test(code), 'the MCP sorts a ranking itself');
    assert.ok(!/BigInt\(/.test(code), 'the MCP compares measured amounts itself');
  });

  test('both rails come back, with the pairing window stated', async () => {
    const client = await connectedClient();
    const payload = payloadOf(
      await client.callTool({ name: 'miorail_b20_market_rails', arguments: {} }),
    );
    assert.ok(payload.exitCapacityLeaders);
    assert.ok(payload.routeCostChanges);
    // Absence from a rail must be readable as an absence of the NUMBER.
    assert.match(String(payload.eligibility), /Absence is not a negative finding/);
    await client.close();
  });
});


// ---------------------------------------------------------------------------
// V2 pass 2 — Compare, Fundamental predicates, and opt-in public context.
//
// All three are ways an agent could be handed something stronger than the
// evidence: a subtraction between incomparable numbers, a predicate answered
// against the wrong denominator, and a search result sitting where a verified
// claim goes.
// ---------------------------------------------------------------------------
describe('compare answers comparability before it answers anything', () => {
  test('it refuses fewer than two and more than five', async () => {
    const client = await connectedClient();
    for (const addresses of [
      [LAUNCH.tokenAddress],
      Array.from({ length: 6 }, (_, index) => `0x${String(index).repeat(40)}`),
    ]) {
      const result = await client.callTool({
        name: 'miorail_compare_b20_tokens',
        arguments: { tokenAddresses: addresses },
      });
      assert.equal((result as { isError?: boolean }).isError, true);
    }
    await client.close();
  });

  test('the same address twice is refused', async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: 'miorail_compare_b20_tokens',
      arguments: { tokenAddresses: [LAUNCH.tokenAddress, LAUNCH.tokenAddress] },
    });
    assert.match(JSON.stringify(result), /duplicate_token_address/);
    await client.close();
  });

  test('an unindexed address is not_in_index, not a zero', async () => {
    const client = await connectedClient();
    const other = `0x${'d'.repeat(40)}`;
    const payload = payloadOf(
      await client.callTool({
        name: 'miorail_compare_b20_tokens',
        arguments: { tokenAddresses: [LAUNCH.tokenAddress, other] },
      }),
    );
    assert.ok('comparable' in payload);
    assert.match(String(payload.comparabilityRule), /profile identity/);
    assert.match(String(payload.ordering), /no aggregate, no winner and no score/);
    assert.match(String(payload.unknownMeaning), /UNKNOWN, never zero/);

    const dimensions = payload.dimensions as {
      key: string;
      note: string;
      values: { token: string; value: unknown; state: string }[];
    }[];
    const roundTrip = dimensions.find((dimension) => dimension.key === 'round_trip_bps')!;
    const missing = roundTrip.values.find((value) => value.token === other)!;
    assert.equal(missing.value, null);
    assert.equal(missing.state, 'not_in_index');
    assert.deepEqual(roundTrip.values.map((value) => value.token), [LAUNCH.tokenAddress, other]);
    await client.close();
  });

  // -------------------------------------------------------------------------
  // The regression. `b20ComparabilityV1` answers "may these be set beside each
  // other", so with fewer than two measurements it returns false with a NULL
  // reason — correct, and read by an agent as "Miorail compared them and they
  // did not match". That sentence is about the tokens. The truth is about
  // Miorail: it held nothing to compare.
  // -------------------------------------------------------------------------
  test('nothing to compare says so, instead of looking like a verdict', async () => {
    const client = await connectedClient();
    const payload = payloadOf(
      await client.callTool({
        name: 'miorail_compare_b20_tokens',
        arguments: { tokenAddresses: [`0x${'d'.repeat(40)}`, `0x${'e'.repeat(40)}`] },
      }),
    );
    assert.equal(payload.comparable, false);
    const reason = String(payload.incomparableReason ?? '');
    assert.notEqual(reason, '', 'comparable:false must never travel without a reason');
    assert.match(reason, /nothing was set side by side/);
    assert.match(reason, /gap in Miorail's coverage/);
    assert.match(reason, /not a finding about the tokens/);
    // The per-token states still say WHICH gap, and are not flattened by it.
    const dimensions = payload.dimensions as { key: string; values: { state: string }[] }[];
    const roundTrip = dimensions.find((dimension) => dimension.key === 'round_trip_bps')!;
    assert.deepEqual(roundTrip.values.map((value) => value.state), ['not_in_index', 'not_in_index']);
    await client.close();
  });

  test('the two shortfalls are worded apart, and neither blames the tokens', () => {
    const none = compareNothingToCompareReasonV1({ requested: 3, withComparableMeasurement: 0 });
    const one = compareNothingToCompareReasonV1({ requested: 3, withComparableMeasurement: 1 });
    assert.match(none, /None of the 3 tokens/);
    assert.match(one, /Only 1 of the 3 tokens/);
    assert.match(one, /a comparison needs two/);
    for (const reason of [none, one]) {
      assert.match(reason, /not a verdict that they are incompatible/);
      assert.match(reason, /not_measured/);
      assert.match(reason, /not_in_index/);
    }
  });

  test('project context is its own dimension, never folded into a measurement', async () => {
    const client = await connectedClient();
    const payload = payloadOf(
      await client.callTool({
        name: 'miorail_compare_b20_tokens',
        arguments: { tokenAddresses: [LAUNCH.tokenAddress, `0x${'d'.repeat(40)}`] },
      }),
    );
    const dimensions = payload.dimensions as { key: string; note: string }[];
    const project = dimensions.find((dimension) => dimension.key === 'project_standing')!;
    assert.match(project.note, /different question from anything measured against a pool/);
    assert.match(project.note, /never a search result/);
    await client.close();
  });
});

describe('a fundamental predicate answers over the claims, not the chain', () => {
  test('every predicate it offers is positive, and the denominator is stated', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const tool = tools.find((entry) => entry.name === 'miorail_find_b20_projects')!;
    const predicates =
      (tool.inputSchema as { properties?: { predicate?: { enum?: string[] } } }).properties?.predicate?.enum ?? [];
    assert.ok(predicates.length >= 8);
    for (const predicate of predicates) {
      assert.ok(!/^no_|_missing$|lacks/.test(predicate), `${predicate} is a negative predicate`);
    }
    assert.match(tool.description ?? '', /denominator is NOT the launch universe/);
    assert.match(tool.description ?? '', /remain UNKNOWN/);
    assert.match(tool.description ?? '', /no way to ask which projects LACK something/);
    await client.close();
  });

  test('an unknown predicate is refused rather than widened', async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: 'miorail_find_b20_projects',
      arguments: { predicate: 'has_a_good_vibe' },
    });
    assert.equal((result as { isError?: boolean }).isError, true);
    await client.close();
  });
});

describe('public context is opt-in and never sits inside the verified layer', () => {
  test('absent by default — not null, which would read as "looked and found nothing"', async () => {
    const client = await connectedClient();
    const payload = payloadOf(
      await client.callTool({
        name: 'miorail_get_b20_opportunity',
        arguments: { tokenAddress: LAUNCH.tokenAddress },
      }),
    );
    assert.ok(!('possiblePublicContext' in payload));
    await client.close();
  });

  test('the opt-in field is a sibling of the verified layer, never inside it', async () => {
    const client = await connectedClient();
    const payload = payloadOf(
      await client.callTool({
        name: 'miorail_get_b20_opportunity',
        arguments: { tokenAddress: LAUNCH.tokenAddress, includePublicContext: true },
      }),
    );
    const context = payload.possiblePublicContext as Record<string, unknown> | undefined;
    assert.ok(context, 'the opt-in field is missing');
    if (typeof context!.unavailableReason === 'string') {
      // No provider in the test environment: it must say it could not look.
      assert.match(context!.unavailableReason, /not a statement about the token/);
    }
    const opportunity = payload.opportunity as Record<string, unknown>;
    assert.ok(!JSON.stringify(opportunity.project ?? {}).includes('possiblePublicContext'));
    await client.close();
  });

  test('the tool tells an agent the two layers are different', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const tool = tools.find((entry) => entry.name === 'miorail_get_b20_opportunity')!;
    assert.match(tool.description ?? '', /Looked up DIRECTLY by address/);
    const schema = tool.inputSchema as { properties?: Record<string, { description?: string }> };
    assert.match(schema.properties?.includePublicContext?.description ?? '', /NOTHING it returns is verified/);
    assert.match(schema.properties?.publicContextDomain?.description ?? '', /NO SEARCH RUNS/);
    await client.close();
  });
});
