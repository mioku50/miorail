import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createMiorailMcpServerV1, MIORAIL_MCP_INSTRUCTIONS_V1 } from './server.js';
import { b20RouteRuntime } from '../b20Control.js';

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

/** A stub repository: the tools are exercised, the database is not. */
function stubObservations(rows: { launch: typeof LAUNCH; observation: unknown }[]) {
  return {
    listFeed: async () => ({ rows, nextCursor: null }),
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
};

before(() => {
  b20RouteRuntime.observations = () => stubObservations([{ launch: LAUNCH, observation: observation() }]);
  b20RouteRuntime.discoverAvailable = async () => true;
  b20RouteRuntime.now = () => new Date('2026-08-05T12:00:00.000Z');
});

after(() => {
  b20RouteRuntime.observations = original.observations;
  b20RouteRuntime.discoverAvailable = original.discoverAvailable;
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
  const typed = result as { structuredContent?: Record<string, unknown>; content?: { text?: string }[] };
  if (typed.structuredContent) return typed.structuredContent;
  return JSON.parse(typed.content?.[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('§8 — tool discovery', () => {
  test('a client sees exactly the five tools, with usable descriptions', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [
        'miorail_discover_status',
        'miorail_explain_b20_rejection',
        'miorail_get_b20_market_leaders',
        'miorail_get_b20_opportunity',
        'miorail_list_b20_opportunities',
      ],
    );
    for (const tool of tools) {
      // An assistant chooses from the description alone. A one-liner produces
      // a model that calls the wrong tool and summarises it wrongly.
      assert.ok((tool.description ?? '').length > 120, `${tool.name} has a thin description`);
    }
    await client.close();
  });

  test('§7 — the server instructions carry all three caveats', async () => {
    // These are what a model reads once, at connection, and what it falls back
    // on when a tool payload is truncated in its context.
    assert.match(MIORAIL_MCP_INSTRUCTIONS_V1, /PROVISIONAL IS NOT QUALIFIED/);
    assert.match(MIORAIL_MCP_INSTRUCTIONS_V1, /NO SUPPORTED ROUTE DOES NOT MEAN NO ROUTE/);
    assert.match(MIORAIL_MCP_INSTRUCTIONS_V1, /EXIT CAPACITY IS MEASURED, NOT INTERPOLATED/);
    assert.match(MIORAIL_MCP_INSTRUCTIONS_V1, /READ-ONLY/);
  });

  test('the market-leaders tool refuses to present itself as a ranking', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const leaders = tools.find((tool) => tool.name === 'miorail_get_b20_market_leaders')!;
    assert.match(leaders.description ?? '', /NOT a ranking, a score, a recommendation or a prediction/);
    // `orderBy` has no default on purpose: there is no default notion of
    // "leading", and inventing one is the interpretation layer §3 forbids.
    assert.deepEqual((leaders.inputSchema as { required?: string[] }).required, ['orderBy']);
    await client.close();
  });
});

describe('§4 — every distinction survives the trip', () => {
  test('a provisional card arrives labelled provisional, with its pre-entry note', async () => {
    const client = await connectedClient();
    const payload = payloadOf(await client.callTool({ name: 'miorail_list_b20_opportunities', arguments: {} }));
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
    const payload = payloadOf(await client.callTool({ name: 'miorail_list_b20_opportunities', arguments: {} }));
    const capacity = ((payload.opportunities as Record<string, unknown>[])[0]!.measurement as Record<string, unknown>)
      .exitCapacity as Record<string, unknown>;
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
        { launch: LAUNCH, observation: observation({ optimisticRoundTripBps: null, largestPassingSizeAtomic: null }) },
      ]);
    const client = await connectedClient();
    const payload = payloadOf(await client.callTool({ name: 'miorail_list_b20_opportunities', arguments: {} }));
    const measurement = (payload.opportunities as Record<string, unknown>[])[0]!.measurement as Record<string, unknown>;
    const roundTrip = measurement.roundTrip as Record<string, unknown>;
    assert.equal(roundTrip.measuredBps, null);
    assert.match(String(roundTrip.note), /not.*zero, free, or cheap/i);
    b20RouteRuntime.observations = () => stubObservations([{ launch: LAUNCH, observation: observation() }]);
    await client.close();
  });

  test('a launch with no block timestamp does not acquire one', async () => {
    const client = await connectedClient();
    const payload = payloadOf(await client.callTool({ name: 'miorail_list_b20_opportunities', arguments: {} }));
    const launch = (payload.opportunities as Record<string, unknown>[])[0]!.launch as Record<string, unknown>;
    assert.equal(launch.launchedAt, null);
    assert.equal(launch.launchTimeKnown, false);
    assert.match(String(launch.note), /do not report that block time as a launch time/i);
    await client.close();
  });

  test('the reason vocabulary is typed, and says which findings a wallet cannot change', async () => {
    const client = await connectedClient();
    const payload = payloadOf(
      await client.callTool({ name: 'miorail_explain_b20_rejection', arguments: { reasonCode: 'no_exit_route' } }),
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
    const payload = payloadOf(await client.callTool({ name: 'miorail_discover_status', arguments: {} }));
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
      name: 'miorail_get_b20_market_leaders',
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
    const result = await client.callTool({ name: 'miorail_execute_trade', arguments: {} }).catch(() => 'threw');
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
    assert.deepEqual(
      sources.map((entry) => entry.name).sort(),
      ['index.ts', 'server.ts', 'tools.ts'],
    );
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
        ((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}),
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
    b20RouteRuntime.observations = () => stubObservations([{ launch: LAUNCH, observation: observation() }]);
    await client.close();
  });

  test('no successful payload carries an internal identifier or a URL', async () => {
    const client = await connectedClient();
    for (const name of ['miorail_discover_status', 'miorail_list_b20_opportunities'] as const) {
      const text = JSON.stringify(payloadOf(await client.callTool({ name, arguments: {} })));
      assert.ok(!/https?:\/\//.test(text), `${name} returned a URL`);
      assert.ok(!/apiKey|api_key|secret|password|Bearer /i.test(text), `${name} returned a credential`);
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
    assert.ok(!tools.includes('createDatabaseB20ObservationRepository'), 'the tools reach the repository directly');
    assert.ok(!tools.includes('b20OpportunityCardV1('), 'the tools build their own cards');
  });
});
