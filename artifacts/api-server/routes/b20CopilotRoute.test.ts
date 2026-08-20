import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe } from 'node:test';
import express from 'express';
import request from 'supertest';

import { b20ControlRouter, b20RouteRuntime } from './b20Control.js';

const TOKEN = '0xb200000000000000000000195a5f43905160ee01';
const WALLET = '0x1111111111111111111111111111111111111111';
const OBSERVATION_ID = `0x${'a'.repeat(64)}`;
const EVIDENCE_HASH = `0x${'b'.repeat(64)}`;
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

const observation = {
  id: OBSERVATION_ID,
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
  poolHookAddress: '0x985c14baa2a18316ffda0aefb3a632fadfca2acc',
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
  evidenceHash: EVIDENCE_HASH,
  createdAt: '2026-08-13T19:06:45.893Z',
} as const;

const row = {
  launch: {
    id: observation.launchId,
    tokenAddress: TOKEN,
    name: 'AVANTIS',
    symbol: 'AVANTIS',
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
};

function repository() {
  return {
    getFeedRowForToken: async ({ tokenAddress }: { tokenAddress: string }) =>
      tokenAddress === TOKEN ? { row, history: [observation] } : null,
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
  b20RouteRuntime.flags = () => ({ routeIntelligenceV1: true, b20ControlV1: true }) as never;
  b20RouteRuntime.discoverAvailable = async () => true;
  b20RouteRuntime.observations = repository;
  b20RouteRuntime.now = () => new Date('2026-08-13T19:10:00.000Z');
  // No narrator unless a test hands one in. Left to the real factory, a unit
  // test would reach a provider over the network the moment a key happened to
  // be in the environment.
  b20RouteRuntime.narrator = () => null;
  b20RouteRuntime.classifier = () => null;
});

afterEach(() => {
  Object.assign(b20RouteRuntime, original);
});

function ask(body: object, authenticated = true) {
  return request(app(authenticated)).post('/api/route-intelligence/opportunities/b20/copilot/ask').send(body);
}

describe('B20 Ask-this-card HTTP boundary', () => {
  test('rehydrates the exact observation and returns deterministic evidence', async () => {
    const response = await ask({
      schemaVersion: 'b20-copilot-ask/v1',
      tokenAddress: TOKEN,
      observationId: OBSERVATION_ID,
      evidenceHash: EVIDENCE_HASH,
      question: 'Why was this rejected?',
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.answerSource, 'deterministic_evidence');
    assert.equal(response.body.observation.observationId, OBSERVATION_ID);
    assert.match(response.body.answer, /no_exit_route/);
    assert.deepEqual(Object.keys(response.body).includes('calls'), false);
  });

  test('refuses a card whose evidence changed after it was rendered', async () => {
    const response = await ask({
      schemaVersion: 'b20-copilot-ask/v1',
      tokenAddress: TOKEN,
      observationId: OBSERVATION_ID,
      evidenceHash: `0x${'c'.repeat(64)}`,
      question: 'What evidence is missing?',
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'b20_observation_changed');
  });

  test('requires paired observation references and an authenticated Base session', async () => {
    const malformed = await ask({
      schemaVersion: 'b20-copilot-ask/v1',
      tokenAddress: TOKEN,
      observationId: OBSERVATION_ID,
      evidenceHash: null,
      question: 'Explain this hook',
    });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.code, 'invalid_b20_copilot_request');

    const unauthenticated = await ask({
      schemaVersion: 'b20-copilot-ask/v1',
      tokenAddress: TOKEN,
      observationId: OBSERVATION_ID,
      evidenceHash: EVIDENCE_HASH,
      question: 'Explain this hook',
    }, false);
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.body.code, 'authentication_required');
  });
});

// ---------------------------------------------------------------------------
// Stage 06 — a model may rephrase this answer, and may not change it.
//
// The deterministic sentence is built first and stays the answer. A narration
// replaces it only by passing the verifier, so these tests are written from the
// outside: whatever the provider says, what does the HTTP response contain?
// ---------------------------------------------------------------------------

function narrator(content: string) {
  return () => ({ generate: async () => ({ message: { role: 'assistant' as const, content } }) });
}

const ASK_V1 = {
  schemaVersion: 'b20-copilot-ask/v1',
  tokenAddress: TOKEN,
  observationId: OBSERVATION_ID,
  evidenceHash: EVIDENCE_HASH,
  question: 'What happened here?',
};

describe('the narrator is walled in on both sides', () => {
  test('with no provider the answer is exactly what shipped before', async () => {
    const response = await ask(ASK_V1);
    assert.equal(response.status, 200);
    assert.equal(response.body.answerSource, 'deterministic_evidence');
  });

  test('a narration that only rephrases the evidence is used, and is labelled', async () => {
    b20RouteRuntime.narrator = narrator(
      'Miorail priced a purchase against the measured pool and could not price a sale back.',
    ) as never;
    const response = await ask(ASK_V1);
    assert.equal(response.status, 200);
    assert.equal(response.body.answerSource, 'verified_narration');
    assert.match(response.body.answer, /could not price a sale/);
  });

  test('a narration with an invented number never reaches the response', async () => {
    // The failure this whole stage exists to prevent: a fluent sentence
    // carrying a figure nobody measured, published under Miorail's name.
    b20RouteRuntime.narrator = narrator('The round trip came in at 2.4% across 812 wallets.') as never;
    const response = await ask(ASK_V1);
    assert.equal(response.status, 200);
    assert.equal(response.body.answerSource, 'deterministic_evidence');
    assert.doesNotMatch(response.body.answer, /2\.4|812/);
  });

  test('a narration that recommends never reaches the response', async () => {
    b20RouteRuntime.narrator = narrator('No exit route found — this looks like a scam, avoid it.') as never;
    const response = await ask(ASK_V1);
    assert.equal(response.body.answerSource, 'deterministic_evidence');
    assert.doesNotMatch(response.body.answer, /scam/i);
  });

  test('the evidence beside the answer is the deterministic one either way', async () => {
    // The model rephrases the sentence. It does not get to touch the facts,
    // the named absences or the caveats a reader checks it against.
    const plain = await ask(ASK_V1);
    b20RouteRuntime.narrator = narrator(
      'Miorail priced a purchase and did not price a sale back.',
    ) as never;
    const narrated = await ask(ASK_V1);
    assert.equal(narrated.body.answerSource, 'verified_narration');
    assert.deepEqual(narrated.body.facts, plain.body.facts);
    assert.deepEqual(narrated.body.missingEvidence, plain.body.missingEvidence);
    assert.deepEqual(narrated.body.caveats, plain.body.caveats);
  });

  test('a narration that reports Miorail’s own gap as the token’s never ships', async () => {
    // This card's standing is `aboutToken: false` — entry priced, the sale did
    // not, and the launch-buying window has not closed, so nothing is
    // established about the token at all. "A purchase priced and a sale did
    // not" is a fluent, figure-free sentence that states it as a property of
    // the token, and every number and vocabulary rule passes it.
    b20RouteRuntime.narrator = narrator('A purchase priced and a sale did not.') as never;
    const response = await ask(ASK_V1);
    assert.equal(response.body.answerSource, 'deterministic_evidence');
  });

  test('a narration that says nothing was measured over a measured card never ships', async () => {
    // The production failure, reproduced at the card. Asked over a bundle full
    // of measurements, the narrator answered "Not measured." No figure was
    // invented, no forbidden word appeared, no outcome was claimed — and the
    // answer was the opposite of its evidence.
    b20RouteRuntime.narrator = narrator('Not measured.') as never;
    const response = await ask(ASK_V1);
    assert.equal(response.body.answerSource, 'deterministic_evidence');
    assert.doesNotMatch(response.body.answer, /^Not measured\.$/);
  });

  test('an out-of-scope question is refused without asking a model at all', async () => {
    let called = 0;
    b20RouteRuntime.narrator = (() => ({
      generate: async () => {
        called += 1;
        return { message: { role: 'assistant' as const, content: 'anything' } };
      },
    })) as never;
    const response = await ask({ ...ASK_V1, question: 'Should I buy this?' });
    assert.equal(response.status, 200);
    assert.equal(called, 0, 'a refused question must not spend a narration');
    assert.equal(response.body.answerSource, 'deterministic_evidence');
    assert.match(response.body.answer, /does not recommend/i);
    // The card's evidence still ships: the question being unanswerable does
    // not make the measurement less true.
    assert.ok(response.body.facts.length > 0);
  });

  test('a provider that throws leaves the answer intact', async () => {
    b20RouteRuntime.narrator = (() => ({
      generate: async () => {
        throw new Error('connect ECONNREFUSED https://api.example.com/v1?key=sk-secret');
      },
    })) as never;
    const response = await ask(ASK_V1);
    assert.equal(response.status, 200);
    assert.equal(response.body.answerSource, 'deterministic_evidence');
    assert.doesNotMatch(JSON.stringify(response.body), /sk-secret/);
  });
});
