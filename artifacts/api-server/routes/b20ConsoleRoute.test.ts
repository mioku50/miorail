import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe } from 'node:test';
import express from 'express';
import request from 'supertest';

import { b20ControlRouter, b20RouteRuntime, resetB20SummaryCacheV1 } from './b20Control.js';

// ---------------------------------------------------------------------------
// The global console's HTTP boundary.
//
// The per-card copilot pins one observation and refuses when it changed. A
// question about the universe has nothing to pin, so what this endpoint owes a
// reader instead is `reads`: which bounded reads ran and what they returned.
// An answer that cannot say what it was built from is an answer nobody can
// check.
// ---------------------------------------------------------------------------

const WALLET = '0x1111111111111111111111111111111111111111';
const TOKEN = '0xb200000000000000000000195a5f43905160ee01';
const OTHER = '0xb200000000000000000000195a5f43905160ee02';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

const observationV1 = (overrides: Record<string, unknown> = {}) => ({
  id: `0x${'a'.repeat(64)}`,
  launchId: `0x${'1'.repeat(64)}:0`,
  chainId: 8453,
  tokenAddress: TOKEN,
  referenceQuoteAsset: USDC,
  referencePositionAtomic: '100000000',
  maxRoundTripBps: 300,
  maxExitSlippageBps: 300,
  profileIdentity: `${USDC}:100000000:300:300`,
  state: 'rejected',
  reasonCode: 'no_exit_route',
  factoryConfirmed: true,
  initialized: true,
  entryRouteFound: true,
  exitRouteFound: false,
  entryRouteHash: `0x${'2'.repeat(64)}`,
  exitRouteHash: null,
  entrySourceKey: 'uniswap-v4:pool',
  exitSourceKey: null,
  poolHookAddress: null,
  entryOutputAtomic: '1000000000000000000',
  optimisticExitReturnAtomic: null,
  optimisticRoundTripBps: null,
  largestPassingSizeAtomic: null,
  firstFailingSizeAtomic: null,
  capacityProbeCount: 0,
  capacityToleranceBps: 300,
  capacityStable: null,
  capacitySamplesHash: null,
  routeCoverage: 'complete',
  viableRouteConfirmed: false,
  bestRouteConfirmed: false,
  venuesConsulted: ['uniswap-v4', 'aerodrome'],
  controlsSnapshotHash: `0x${'3'.repeat(64)}`,
  controlsBlockNumber: '49929328',
  transfersPaused: false,
  transferPolicyState: 'open',
  controlsComplete: true,
  observationBlockNumber: '49929328',
  observationBlockHash: `0x${'4'.repeat(64)}`,
  quoteAlignment: 'anchored',
  measuredAt: '2026-08-13T19:06:45.893Z',
  staleAfter: '2026-08-13T19:21:45.893Z',
  measurementVersion: 'b20-observation/v1',
  evidenceHash: `0x${'b'.repeat(64)}`,
  createdAt: '2026-08-13T19:06:45.893Z',
  ...overrides,
});

const rowV1 = (tokenAddress: string, observation: Record<string, unknown> | null) => ({
  launch: {
    id: `${tokenAddress}:0`,
    tokenAddress,
    name: 'AVANTIS',
    symbol: tokenAddress === TOKEN ? 'AVA' : 'NTIS',
    variant: 'asset',
    decimals: 18,
    blockNumber: '49929300',
    transactionHash: `0x${'1'.repeat(64)}`,
    logIndex: 0,
    detectedAt: '2026-08-13T18:00:00.000Z',
    blockTimestamp: '2026-08-13T17:59:00.000Z',
    canonical: true,
  },
  observation,
  launchBuyers: null,
});

function repository(options: { moverPairs?: unknown[] } = {}) {
  return {
    getFeedRowForToken: async ({ tokenAddress }: { tokenAddress: string }) => {
      if (tokenAddress === TOKEN) return { row: rowV1(TOKEN, observationV1()), history: [observationV1()] };
      if (tokenAddress === OTHER) {
        return {
          row: rowV1(OTHER, observationV1({ tokenAddress: OTHER, referencePositionAtomic: '500000000' })),
          history: [observationV1({ tokenAddress: OTHER })],
        };
      }
      return null;
    },
    listFeed: async () => ({ rows: [rowV1(TOKEN, observationV1())], nextCursor: null }),
    listMoverPairs: async () => options.moverPairs ?? [],
    pipelineCounts: async () => ({
      ingestionCursorBlock: '49929340',
      lastIngestionConfirmedHead: '49929350',
      lastIngestionRunAt: '2026-08-13T19:07:00.000Z',
      lastIngestionResult: 'success',
      lastMeasurementRunAt: '2026-08-13T19:06:45.893Z',
      canonicalLaunchCount: 1,
      launchesAwaitingMeasurement: 0,
      observationCount: 1,
      observationsLastRun: 1,
      lastIngestionBudgetExhausted: false,
      ingestionOperatorState: null,
    }),
  } as never;
}

function app(authenticated = true) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    if (authenticated) {
      Object.defineProperty(req, 'session', {
        configurable: true,
        value: { user: { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 } },
      });
    }
    next();
  });
  server.use('/api/route-intelligence', b20ControlRouter);
  return server;
}

const original = { ...b20RouteRuntime };

beforeEach(() => {
  resetB20SummaryCacheV1();
  b20RouteRuntime.flags = () => ({ routeIntelligenceV1: true, b20ControlV1: true }) as never;
  b20RouteRuntime.discoverAvailable = async () => true;
  b20RouteRuntime.observations = () => repository();
  b20RouteRuntime.now = () => new Date('2026-08-13T19:10:00.000Z');
  // Left to the real factory a unit test reaches a provider over the network
  // the moment a key happens to be in the environment.
  b20RouteRuntime.narrator = () => null;
  // Same reasoning for the identity fallback: without a stub this would open a
  // socket to Base the moment an RPC URL is configured. `not_b20` is the
  // default so a test that means to assert a confirmation has to say so.
  b20RouteRuntime.reader = () => fakeReaderV1({ isB20: false });
});

/**
 * The narrow slice of B20ReaderV1 the identity fallback touches: an anchor and
 * two factory calls. Anything else throwing is correct — it would mean the
 * fallback grew a read this test does not know about.
 */
function fakeReaderV1(options: { isB20: boolean; initialised?: boolean; fail?: boolean }) {
  const fail = { ok: false as const, reason: 'transport' as const };
  const anchor = options.fail
    ? fail
    : {
        ok: true as const,
        value: { blockNumber: '50044247', blockHash: `0x${'a'.repeat(64)}`, blockTag: '0x2fb9f14' },
        raw: `0x${'a'.repeat(64)}`,
      };
  return {
    readBlockAnchor: async () => anchor,
    readIsB20: async () => (options.fail ? fail : { ok: true as const, value: options.isB20 }),
    readIsB20Initialized: async () =>
      options.fail ? fail : { ok: true as const, value: options.initialised ?? true },
    readVariantActivated: async () => (options.fail ? fail : { ok: true as const, value: true }),
    call: async () => fail,
    callMany: async () => [fail],
  } as never;
}

afterEach(() => {
  resetB20SummaryCacheV1();
  Object.assign(b20RouteRuntime, original);
});

function ask(body: object, authenticated = true) {
  return request(app(authenticated)).post('/api/route-intelligence/opportunities/b20/console/ask').send(body);
}

describe('the console answers about the universe', () => {
  test('Explore returns counts and says what they were built from', async () => {
    const response = await ask({
      schemaVersion: 'b20-console-ask/v1',
      scope: 'explore',
      question: 'What does the universe look like?',
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.scope, 'explore');
    assert.equal(response.body.answerSource, 'deterministic_evidence');
    assert.ok(response.body.reads.some((read: { tool: string }) => read.tool === 'summary'));
    assert.ok(response.body.caveats.length > 0);
  });

  test('no wallet, calldata or payment leaves this endpoint', async () => {
    const response = await ask({
      schemaVersion: 'b20-console-ask/v1',
      scope: 'explore',
      question: 'How many launches are there?',
    });
    const body = JSON.stringify(response.body);
    for (const forbidden of ['calls', 'calldata', 'router', 'permission', 'spender', 'privateKey']) {
      assert.equal(body.includes(`"${forbidden}"`), false, `${forbidden} appeared in a read-only answer`);
    }
    assert.equal(body.includes(WALLET), false);
  });
});

describe('the console answers about named tokens', () => {
  test('Investigate reads exactly the tokens it was given', async () => {
    const response = await ask({
      schemaVersion: 'b20-console-ask/v1',
      scope: 'investigate',
      question: 'Compare these two.',
      tokenAddresses: [TOKEN, OTHER],
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.intent, 'compare_tokens');
    assert.equal(response.body.reads.length, 2);
  });

  test('tokens measured at different reference positions are not ranked', async () => {
    // The two fixtures differ only in reference position — which is exactly
    // the case where two round trips look comparable and are not.
    const response = await ask({
      schemaVersion: 'b20-console-ask/v1',
      scope: 'investigate',
      question: 'Which of these is cheaper to get out of?',
      tokenAddresses: [TOKEN, OTHER],
    });
    assert.ok(
      response.body.caveats.some((caveat: string) => /different reference positions/.test(caveat)),
      JSON.stringify(response.body.caveats),
    );
  });

  test('an address in the question moves the answer to that token, and says so', async () => {
    const response = await ask({
      schemaVersion: 'b20-console-ask/v1',
      scope: 'explore',
      question: `what about ${TOKEN}`,
    });
    assert.equal(response.body.scope, 'investigate');
    assert.equal(response.body.intent, 'compare_tokens');
  });

  test('an unknown address is answered, not errored', async () => {
    const response = await ask({
      schemaVersion: 'b20-console-ask/v1',
      scope: 'investigate',
      question: `what about 0x${'9'.repeat(40)}`,
    });
    assert.equal(response.status, 200);
    // The factory answered no, so the answer is the factory's, not a claim
    // about what Miorail happens to hold.
    assert.match(response.body.answer, /not confirmed as a B20 token by the B20 factory/i);
  });

  // The MIO defect, end to end through the route. An address the index does not
  // have but the factory confirms must not be denied.
  const MIO_V1 = '0xb200000000000000000000578f3ae29d9e6e0101';

  test('a factory-confirmed address missing from the index is not called a non-B20', async () => {
    b20RouteRuntime.reader = () => fakeReaderV1({ isB20: true });
    const response = await ask({
      schemaVersion: 'b20-console-ask/v1',
      scope: 'investigate',
      question: `check mio token ${MIO_V1}`,
    });
    assert.equal(response.status, 200);
    assert.doesNotMatch(response.body.answer, /not a canonical B20/i);
    assert.doesNotMatch(response.body.answer, /not a B20/i);
    assert.match(response.body.answer, /confirmed onchain/i);
    assert.match(response.body.answer, /Discover index/i);
  });

  test('an identity check that cannot run concludes nothing', async () => {
    b20RouteRuntime.reader = () => fakeReaderV1({ isB20: true, fail: true });
    const response = await ask({
      schemaVersion: 'b20-console-ask/v1',
      scope: 'investigate',
      question: `check ${MIO_V1}`,
    });
    assert.equal(response.status, 200);
    assert.match(response.body.answer, /could not be completed/i);
    assert.doesNotMatch(response.body.answer, /not a B20/i);
    assert.doesNotMatch(response.body.answer, /confirmed onchain/i);
  });

  test('a reader that throws does not fail the answer', async () => {
    // Fail-closed means the request still succeeds with an honest uncertainty,
    // not a 500. The rest of an Investigate answer may be perfectly good.
    b20RouteRuntime.reader = () => {
      throw new Error('BASE_MAINNET_RPC_URL is not set');
    };
    const response = await ask({
      schemaVersion: 'b20-console-ask/v1',
      scope: 'investigate',
      question: `check ${MIO_V1}`,
    });
    assert.equal(response.status, 200);
    assert.match(response.body.answer, /could not be completed/i);
  });
});

describe('the private scope is private', () => {
  test('a portfolio answer is never sent to a language model', async () => {
    // The bundle for this scope is the wallet's own token list. Sending it to
    // a provider for a nicer sentence is a trade nobody agreed to, and the
    // provider is withheld rather than a downstream check being trusted.
    let called = false;
    b20RouteRuntime.narrator = () => ({
      generate: async () => {
        called = true;
        return { message: { role: 'assistant' as const, content: 'a narration' } };
      },
    }) as never;

    const response = await ask({
      schemaVersion: 'b20-console-ask/v1',
      scope: 'portfolio',
      question: 'Which of my positions is hardest to close?',
      tokenAddresses: [TOKEN, OTHER],
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(called, false, 'the narrator was called with a wallet’s holdings');
    assert.equal(response.body.answerSource, 'deterministic_evidence');
  });

  test('the SAME question in a public scope does reach the narrator', async () => {
    // The control. Without it, the test above passes whenever the narrator is
    // unreachable for an unrelated reason and proves nothing.
    let called = false;
    b20RouteRuntime.narrator = () => ({
      generate: async () => {
        called = true;
        return { message: { role: 'assistant' as const, content: 'Miorail could price a purchase but not a sale.' } };
      },
    }) as never;

    await ask({
      schemaVersion: 'b20-console-ask/v1',
      scope: 'investigate',
      question: 'Which of my positions is hardest to close?',
      tokenAddresses: [TOKEN],
    });
    assert.equal(called, true);
  });

  test('the reads do not repeat the wallet’s holdings back into a log line', async () => {
    const response = await ask({
      schemaVersion: 'b20-console-ask/v1',
      scope: 'portfolio',
      question: 'Which of my positions is hardest to close?',
      tokenAddresses: [TOKEN, OTHER],
    });
    const reads = JSON.stringify(response.body.reads);
    assert.equal(reads.includes(TOKEN), false);
    assert.equal(reads.includes(OTHER), false);
    assert.match(reads, /2 held tokens/);
  });

  test('the size that was measured is not the size being held, and the answer says so', async () => {
    const response = await ask({
      schemaVersion: 'b20-console-ask/v1',
      scope: 'portfolio',
      question: 'Can I get out?',
      tokenAddresses: [TOKEN],
    });
    assert.match(response.body.answer, /not at the size you are holding/);
    assert.ok(response.body.caveats.some((caveat: string) => /never sent to a language model/.test(caveat)));
  });

  test('portfolio with no tokens says Miorail does not enumerate a wallet', async () => {
    const response = await ask({
      schemaVersion: 'b20-console-ask/v1',
      scope: 'portfolio',
      question: 'What do I hold?',
    });
    assert.match(response.body.answer, /Miorail does not enumerate a wallet/);
    assert.deepEqual(response.body.reads, []);
  });

  test('Investigate still refuses more than five, and Portfolio takes more', async () => {
    const six = Array.from({ length: 6 }, (_value, index) => `0x${String(index).repeat(40)}`);
    assert.equal(
      (await ask({ schemaVersion: 'b20-console-ask/v1', scope: 'investigate', question: 'compare', tokenAddresses: six })).status,
      400,
    );
    assert.equal(
      (await ask({ schemaVersion: 'b20-console-ask/v1', scope: 'portfolio', question: 'rank', tokenAddresses: six })).status,
      200,
    );
  });
});

describe('the console answers about change', () => {
  test('an empty movers rail is never "nothing moved"', async () => {
    const response = await ask({
      schemaVersion: 'b20-console-ask/v1',
      scope: 'changes',
      question: 'What changed?',
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.intent, 'measured_changes');
    assert.doesNotMatch(response.body.answer, /nothing moved\.|no movement/i);
    assert.match(response.body.answer, /compared across 24 hours/);
  });
});

describe('refusals cost nothing and reveal nothing', () => {
  test('an out-of-scope question is refused without a read', async () => {
    const response = await ask({
      schemaVersion: 'b20-console-ask/v1',
      scope: 'explore',
      question: 'Which of these will moon?',
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.intent, 'unsupported');
    assert.deepEqual(response.body.reads, []);
    assert.deepEqual(response.body.facts, []);
  });

  test('Investigate with no token says what it needs', async () => {
    const response = await ask({
      schemaVersion: 'b20-console-ask/v1',
      scope: 'investigate',
      question: 'tell me about it',
    });
    assert.match(response.body.answer, /Paste one or more Base token addresses/);
  });

  test('a malformed request and an unauthenticated one are distinct', async () => {
    const malformed = await ask({ schemaVersion: 'b20-console-ask/v1', scope: 'nowhere', question: 'hi there' });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.code, 'invalid_b20_console_request');

    const anonymous = await ask(
      { schemaVersion: 'b20-console-ask/v1', scope: 'explore', question: 'How many launches?' },
      false,
    );
    assert.equal(anonymous.status, 401);
  });

  test('more than five tokens is refused by the schema rather than truncated silently', async () => {
    const response = await ask({
      schemaVersion: 'b20-console-ask/v1',
      scope: 'investigate',
      question: 'compare',
      tokenAddresses: Array.from({ length: 6 }, (_value, index) => `0x${String(index).repeat(40)}`),
    });
    assert.equal(response.status, 400);
  });
});

// ---------------------------------------------------------------------------
// Targeted measurement — a reading taken because a reader asked.
//
// The gap: Discover's worker measures launches inside a 48-hour age window, so
// a launch that missed its window was never measured and never would be.
// Investigate answered "No stored measurement", which is true of Miorail and
// reads as a finding about the token. Every test here is about telling those
// two apart.
// ---------------------------------------------------------------------------

const UNMEASURED = '0xb200000000000000000000195a5f43905160ee03';
const THIRD = '0xb200000000000000000000195a5f43905160ee04';

function unmeasuredRepository() {
  return {
    ...(repository() as unknown as Record<string, unknown>),
    getFeedRowForToken: async ({ tokenAddress }: { tokenAddress: string }) => {
      if (tokenAddress === TOKEN) return { row: rowV1(TOKEN, observationV1()), history: [observationV1()] };
      // Indexed, canonical, and never measured — the state 820 launches were in
      // on the day this was written.
      if (tokenAddress === UNMEASURED) return { row: rowV1(UNMEASURED, null), history: [] };
      if (tokenAddress === THIRD) return { row: rowV1(THIRD, null), history: [] };
      return null;
    },
  } as never;
}

function investigate(question: string) {
  return ask({ schemaVersion: 'b20-console-ask/v1', scope: 'investigate', question });
}

describe('Investigate measures a token it was asked about', () => {
  beforeEach(() => {
    b20RouteRuntime.observations = () => unmeasuredRepository();
    b20RouteRuntime.rpcConfigured = () => true;
    b20RouteRuntime.flags = () =>
      ({ routeIntelligenceV1: true, b20ControlV1: true, b20TargetedMeasureV1: true }) as never;
  });

  test('with the flag off nothing is measured and the answer is what shipped before', async () => {
    b20RouteRuntime.flags = () => ({ routeIntelligenceV1: true, b20ControlV1: true }) as never;
    let called = 0;
    b20RouteRuntime.measureOnDemand = (async () => {
      called += 1;
      throw new Error('must not be reached');
    }) as never;
    const response = await investigate(`What was measured here? ${UNMEASURED}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(called, 0);
    assert.match(response.body.answer, /no stored observation/);
  });

  test('an unmeasured launch is measured now, and the answer says the reading was taken', async () => {
    let measured: string[] = [];
    b20RouteRuntime.measureOnDemand = (async (input: { launch: { tokenAddress: string } }) => {
      measured.push(input.launch.tokenAddress);
      return { tokenAddress: input.launch.tokenAddress, outcome: 'measured', reason: null, elapsedMs: 900 };
    }) as never;
    const response = await investigate(`What was measured here? ${UNMEASURED}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(measured, [UNMEASURED]);
    assert.match(response.body.answer, /took an Exit-First reading/);
  });

  test('a launch age of any size is measurable — the 48-hour window is the QUEUE’s, not the reader’s', async () => {
    // MIO launched 739,000 blocks before Discover started. The worker will
    // never reach a launch like that, and a reader asking about one must not be
    // refused for the age of a row.
    b20RouteRuntime.observations = () =>
      ({
        ...(unmeasuredRepository() as unknown as Record<string, unknown>),
        getFeedRowForToken: async ({ tokenAddress }: { tokenAddress: string }) =>
          tokenAddress === UNMEASURED
            ? {
                row: {
                  ...rowV1(UNMEASURED, null),
                  launch: { ...rowV1(UNMEASURED, null).launch, detectedAt: '2026-01-01T00:00:00.000Z' },
                },
                history: [],
              }
            : null,
      }) as never;
    let called = 0;
    b20RouteRuntime.measureOnDemand = (async (input: { launch: { tokenAddress: string } }) => {
      called += 1;
      return { tokenAddress: input.launch.tokenAddress, outcome: 'measured', reason: null, elapsedMs: 5 };
    }) as never;
    await investigate(`Check ${UNMEASURED}`);
    assert.equal(called, 1);
  });

  test('a fresh observation is used as it stands, and costs nothing', async () => {
    let called = 0;
    b20RouteRuntime.measureOnDemand = (async () => {
      called += 1;
      return { tokenAddress: TOKEN, outcome: 'measured', reason: null, elapsedMs: 5 };
    }) as never;
    const response = await investigate(`What was measured here? ${TOKEN}`);
    assert.equal(response.status, 200);
    assert.equal(called, 0, 'a current measurement must not be re-taken');
  });

  test('an endpoint that did not answer is Miorail’s fact, never the token’s', async () => {
    b20RouteRuntime.measureOnDemand = (async (input: { launch: { tokenAddress: string } }) => ({
      tokenAddress: input.launch.tokenAddress,
      outcome: 'provider_unavailable',
      reason: null,
      elapsedMs: 4000,
    })) as never;
    const response = await investigate(`Check ${UNMEASURED}`);
    assert.match(response.body.answer, /endpoint did not answer/);
    assert.match(response.body.answer, /establishes nothing either way about the token/);
    // And the absence is NAMED, so a reader can see what is missing rather than
    // inferring it from a sentence.
    assert.ok(
      response.body.missingEvidence.some((entry: string) => /attempted one now and the endpoint did not answer/.test(entry)),
      JSON.stringify(response.body.missingEvidence),
    );
  });

  test('a reading still running is said to be running, not reported as absent', async () => {
    b20RouteRuntime.measureOnDemand = (async (input: { launch: { tokenAddress: string } }) => ({
      tokenAddress: input.launch.tokenAddress,
      outcome: 'timed_out',
      reason: null,
      elapsedMs: 25_000,
    })) as never;
    const response = await investigate(`Check ${UNMEASURED}`);
    assert.match(response.body.answer, /still running/);
    assert.ok(!/has no measurement$/.test(response.body.answer));
  });

  test('an incomplete reading names its gap in the measurement’s own words', async () => {
    b20RouteRuntime.measureOnDemand = (async (input: { launch: { tokenAddress: string } }) => ({
      tokenAddress: input.launch.tokenAddress,
      outcome: 'measurement_incomplete',
      reason: 'route_search_degraded',
      elapsedMs: 3000,
    })) as never;
    const response = await investigate(`Check ${UNMEASURED}`);
    const fact = response.body.facts.find((entry: { value: string }) => /route search degraded/.test(entry.value));
    assert.ok(fact, JSON.stringify(response.body.facts));
  });

  test('a request may cause at most two readings, and says which it did not reach', async () => {
    const seen: string[] = [];
    b20RouteRuntime.measureOnDemand = (async (input: { launch: { tokenAddress: string } }) => {
      seen.push(input.launch.tokenAddress);
      return { tokenAddress: input.launch.tokenAddress, outcome: 'measured', reason: null, elapsedMs: 5 };
    }) as never;
    // Three unmeasured launches, so the cap is the only thing that can stop
    // the third. TOKEN would be skipped for being current, which proves
    // nothing about the cap.
    b20RouteRuntime.observations = () =>
      ({
        ...(unmeasuredRepository() as unknown as Record<string, unknown>),
        getFeedRowForToken: async ({ tokenAddress }: { tokenAddress: string }) =>
          [UNMEASURED, THIRD, OTHER].includes(tokenAddress)
            ? { row: rowV1(tokenAddress, null), history: [] }
            : null,
      }) as never;
    const response = await investigate(`Compare ${UNMEASURED} ${THIRD} ${OTHER}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(seen, [UNMEASURED, THIRD]);
    assert.match(response.body.answer, /did not reach/);
  });

  test('a token past the cap whose measurement is current is not reported as unreached', async () => {
    // "Not reached" is a gap, and a token that needed nothing has none. Naming
    // one would be the same defect this whole path exists to remove, in
    // miniature.
    b20RouteRuntime.measureOnDemand = (async (input: { launch: { tokenAddress: string } }) => ({
      tokenAddress: input.launch.tokenAddress,
      outcome: 'measured',
      reason: null,
      elapsedMs: 5,
    })) as never;
    const response = await investigate(`Compare ${UNMEASURED} ${THIRD} ${TOKEN}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.ok(!/did not reach/.test(response.body.answer), response.body.answer);
  });

  test('an enabled server with no endpoint says so about itself', async () => {
    b20RouteRuntime.rpcConfigured = () => false;
    const response = await investigate(`Check ${UNMEASURED}`);
    assert.match(response.body.answer, /no Base endpoint configured/);
    assert.match(response.body.answer, /fact about this server, not about the token/);
  });

  test('Portfolio never causes a reading, whatever the flag says', async () => {
    // A holder's token list is a wallet's holdings. Spending a metered reading
    // per holding on every question would turn a ranking into a measurement run.
    let called = 0;
    b20RouteRuntime.measureOnDemand = (async () => {
      called += 1;
      return { tokenAddress: UNMEASURED, outcome: 'measured', reason: null, elapsedMs: 5 };
    }) as never;
    const response = await ask({
      schemaVersion: 'b20-console-ask/v1',
      scope: 'portfolio',
      question: 'Which of my positions is hardest to close?',
      tokenAddresses: [UNMEASURED],
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(called, 0);
  });
});
