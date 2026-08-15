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
});

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
    assert.match(response.body.answer, /not a canonical B20 launch/);
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
