import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import {
  createRouteOutcomeProjectorV1,
  type OutcomeProjectionPortV1,
  type RouteProviderOutcomeV1,
} from '../src/index.js';
import { candidateFixtureV1, proofFixtureV1 } from './fixtures.js';

/** An in-memory port that refuses exactly what the unique index refuses. */
function port(overrides: Partial<OutcomeProjectionPortV1> = {}): OutcomeProjectionPortV1 & {
  rows: RouteProviderOutcomeV1[];
} {
  const rows: RouteProviderOutcomeV1[] = [];
  const candidate = candidateFixtureV1({ providerId: 'uniswap' });
  return {
    rows,
    async findCandidateByHash({ candidateHash }) {
      return candidateHash === candidate.candidateHash ? candidate : null;
    },
    async getOutcomeByProofId({ tenantId, proofId }) {
      return rows.find((row) => row.proofId === proofId && row.tenantId === tenantId) ?? null;
    },
    async insertOutcome(outcome) {
      if (rows.some((row) => row.proofId === outcome.proofId)) {
        throw new Error('duplicate proof_id');
      }
      rows.push(outcome);
    },
    ...overrides,
  };
}

function proofFor(candidateHash: `0x${string}`, finalStatus?: 'completed' | 'cancelled') {
  return proofFixtureV1({ candidateHash, finalStatus });
}

describe('the projector writes at most one outcome per proof', () => {
  test('a terminal proof records one outcome', async () => {
    const candidate = candidateFixtureV1({ providerId: 'uniswap' });
    const store = port();
    const projector = createRouteOutcomeProjectorV1(store);
    const { proof, events } = proofFor(candidate.candidateHash);

    const result = await projector.projectFinalizedProof({
      proof,
      events,
      routeRunId: 'run-1',
      now: new Date(),
    });
    assert.equal(result.status, 'recorded');
    assert.equal(store.rows.length, 1);
  });

  test('a repeated finalization is a no-op, not a second row', async () => {
    const candidate = candidateFixtureV1({ providerId: 'uniswap' });
    const store = port();
    const projector = createRouteOutcomeProjectorV1(store);
    const { proof, events } = proofFor(candidate.candidateHash);
    const input = { proof, events, routeRunId: 'run-1', now: new Date() };

    await projector.projectFinalizedProof(input);
    const second = await projector.projectFinalizedProof(input);
    assert.equal(second.status, 'already_recorded');
    assert.equal(store.rows.length, 1);
  });

  test('a proof whose hash changed after finalization fails closed', async () => {
    // Either a bug or tampering. Overwriting the row would erase the evidence.
    const candidate = candidateFixtureV1({ providerId: 'uniswap' });
    const store = port();
    const projector = createRouteOutcomeProjectorV1(store);
    const { proof, events } = proofFor(candidate.candidateHash);
    await projector.projectFinalizedProof({ proof, events, routeRunId: 'run-1', now: new Date() });

    const result = await projector.projectFinalizedProof({
      proof: { ...proof, proofHash: '0x'.padEnd(66, 'e') as `0x${string}` },
      events,
      routeRunId: 'run-1',
      now: new Date(),
    });
    assert.equal(result.status, 'conflict');
    assert.equal(store.rows.length, 1);
  });

  test('a cancelled proof is skipped with its own reason', async () => {
    const candidate = candidateFixtureV1({ providerId: 'uniswap' });
    const store = port();
    const projector = createRouteOutcomeProjectorV1(store);
    const { proof, events } = proofFor(candidate.candidateHash, 'cancelled');

    const result = await projector.projectFinalizedProof({
      proof,
      events,
      routeRunId: 'run-1',
      now: new Date(),
    });
    assert.equal(result.status, 'skipped');
    assert.equal(store.rows.length, 0);
  });

  test('a missing candidate is skipped rather than guessed at', async () => {
    const store = port();
    const projector = createRouteOutcomeProjectorV1(store);
    const { proof, events } = proofFor('0x'.padEnd(66, 'a') as `0x${string}`);

    const result = await projector.projectFinalizedProof({
      proof,
      events,
      routeRunId: 'run-1',
      now: new Date(),
    });
    assert.equal(result.status, 'skipped');
    if (result.status !== 'skipped') return;
    assert.equal(result.reason, 'candidate_not_found');
  });
});

describe('a projection failure never reaches the caller as an exception', () => {
  test('a storage error comes back as a value', async () => {
    // The proof is already terminal and already stored. A statistics table
    // refusing a row is not a reason to unwind somebody's settled trade.
    const candidate = candidateFixtureV1({ providerId: 'uniswap' });
    const store = port({
      async insertOutcome() {
        throw new Error('connection reset');
      },
    });
    const projector = createRouteOutcomeProjectorV1(store);
    const { proof, events } = proofFor(candidate.candidateHash);

    const result = await projector.projectFinalizedProof({
      proof,
      events,
      routeRunId: 'run-1',
      now: new Date(),
    });
    assert.equal(result.status, 'failed');
    if (result.status !== 'failed') return;
    assert.match(result.detail, /connection reset/);
  });

  test('a failed lookup is also a value, so the reconcile response is unaffected', async () => {
    const store = port({
      async getOutcomeByProofId() {
        throw new Error('table missing');
      },
    });
    const projector = createRouteOutcomeProjectorV1(store);
    const { proof, events } = proofFor(candidateFixtureV1({ providerId: 'uniswap' }).candidateHash);

    const result = await projector.projectFinalizedProof({
      proof,
      events,
      routeRunId: 'run-1',
      now: new Date(),
    });
    assert.equal(result.status, 'failed');
  });
});
