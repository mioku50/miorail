import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe } from 'node:test';
import express from 'express';
import request from 'supertest';
import { InMemorySubmissionAttemptRepositoryV1 } from '@mioagent/route-storage';
import type { NftStorageRepository, RouteStorageRepository } from '@mioagent/route-storage';
import { routeProofIdV1 } from '@mioagent/transaction-composer';
import { submissionRecoveryRouter, submissionRecoveryRuntime } from './submissionRecovery.js';

// Recovery must never reach the network. A stub that forgets to intercept
// fails loudly instead of quietly calling out.
globalThis.fetch = (() => {
  throw new Error('live network call attempted in a unit test');
}) as unknown as typeof fetch;

const WALLET = '0x1111111111111111111111111111111111111111';
const USER = { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 as const };
const OTHER_WALLET = '0x2222222222222222222222222222222222222222';
const OTHER = { id: `eip155:8453:${OTHER_WALLET}`, address: OTHER_WALLET, chainId: 8453 as const };
const HASH = `0x${'ab'.repeat(32)}`;
const NOW = new Date('2026-07-27T12:00:00.000Z');
// The proof id is DERIVED from the blueprint, not taken from the request — so
// the expectation is derived too rather than hardcoded to a fixture value.
const PROOF_ID = routeProofIdV1('blueprint-1');

const FLAGS = {
  routeIntelligenceV1: true,
  legacyTerminal: true,
  paidIntelligence: false,
  earnRouteV1: false,
  commerceRouteV1: false,
  commerceExecutionV1: false,
  nftRouteV1: false,
  nftExecutionV1: false,
  privateAiRouteV1: false,
  privateAiExecutionV1: false,
  aerodromeExecutionV1: false,
  b20ControlV1: false,
  submissionRecoveryV1: true,
  publicProofV1: false,
  mcpPrivateV1: false,
  mcpPrivateExecutionV1: false,
  routeOutcomeFeedbackV1: false, tokenIdentityV1: false,
};

const original = { ...submissionRecoveryRuntime };
let repository: InMemorySubmissionAttemptRepositoryV1;
let blueprintStatus: string;
let storedCallsHash: string;

/** Only the four methods the binding check calls. Anything else being reached
 * is itself a failure, so the rest throw. */
function fakeRouteRepository(): RouteStorageRepository {
  const unexpected = () => {
    throw new Error('the binding check reached an unexpected repository method');
  };
  return new Proxy(
    {
      async getRouteRun(id: string, userId: string) {
        if (id !== 'run-1' || userId !== USER.id) return null;
        return { walletAddress: WALLET, chainId: 8453 };
      },
      async getEarnRouteRun() {
        return null;
      },
      async listBlueprints(runId: string, userId: string) {
        if (runId !== 'run-1' || userId !== USER.id) return [];
        return [
          {
            blueprint: {
              id: 'blueprint-1',
              status: blueprintStatus,
              approvedCallsHash: storedCallsHash,
            },
          },
        ];
      },
      async getProofProjection(id: string) {
        return id === PROOF_ID ? { id, finalStatus: 'pending' } : null;
      },
    } as unknown as RouteStorageRepository,
    { get: (target, key) => (key in target ? (target as never)[key] : unexpected) },
  );
}

function fakeNftRepository(): NftStorageRepository {
  return {
    async getNftPurchaseBlueprint() {
      return null;
    },
    async getNftProofByBlueprint() {
      return null;
    },
  } as unknown as NftStorageRepository;
}

function app(user: typeof USER | null = USER) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    if (user) Object.defineProperty(req, 'session', { configurable: true, value: { user } });
    next();
  });
  server.use('/api/route-intelligence', submissionRecoveryRouter);
  return server;
}

beforeEach(() => {
  let sequence = 0;
  repository = new InMemorySubmissionAttemptRepositoryV1(() => {
    sequence += 1;
    return `submission-attempt:${sequence}`;
  });
  blueprintStatus = 'approved';
  storedCallsHash = HASH;
  submissionRecoveryRuntime.flags = () => ({ ...FLAGS });
  submissionRecoveryRuntime.repository = () => repository;
  submissionRecoveryRuntime.routeRepository = fakeRouteRepository;
  submissionRecoveryRuntime.nftRepository = fakeNftRepository;
  submissionRecoveryRuntime.migrationAvailable = async () => true;
  submissionRecoveryRuntime.now = () => NOW;
});

afterEach(() => {
  Object.assign(submissionRecoveryRuntime, original);
});

const body = {
  walletAddress: WALLET,
  goal: 'swap' as const,
  routeRunId: 'run-1',
  blueprintId: 'blueprint-1',
  approvedCallsHash: HASH,
};

function create(payload: unknown = body, server = app()) {
  return request(server).post('/api/route-intelligence/submission-attempts').send(payload as object);
}

describe('the gates', () => {
  test('the route is 404 while the flag is off', async () => {
    submissionRecoveryRuntime.flags = () => ({ ...FLAGS, submissionRecoveryV1: false });
    const response = await create();
    assert.equal(response.status, 404);
    assert.equal(response.body.code, 'submission_recovery_disabled');
  });

  test('an unauthenticated caller gets 401 and reaches no repository', async () => {
    let touched = false;
    submissionRecoveryRuntime.repository = () => {
      touched = true;
      return repository;
    };
    assert.equal((await create(body, app(null))).status, 401);
    assert.equal(touched, false);
  });

  test('a body naming another wallet is refused, whatever the session says', async () => {
    const response = await create({ ...body, walletAddress: OTHER_WALLET });
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'wallet_binding_mismatch');
  });

  test('a missing migration is a stable 503, never a partial write', async () => {
    submissionRecoveryRuntime.migrationAvailable = async () => false;
    const response = await create();
    assert.equal(response.status, 503);
  });
});

describe('creating an attempt re-verifies everything', () => {
  test('an approved blueprint with matching calls opens an attempt', async () => {
    const response = await create();
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.attempt.status, 'wallet_pending');
    assert.equal(response.body.attempt.batchId, null);
    assert.equal(response.body.attempt.proofId, PROOF_ID);
  });

  test('a repeat request is idempotent', async () => {
    const first = await create();
    const second = await create();
    assert.equal(first.body.attempt.id, second.body.attempt.id);
  });

  test('an unapproved blueprint cannot get an attempt', async () => {
    blueprintStatus = 'prepared';
    const response = await create();
    assert.equal(response.status, 404);
    assert.equal(response.body.code, 'blueprint_not_approved');
  });

  test('a different approved-calls hash is refused', async () => {
    storedCallsHash = `0x${'cd'.repeat(32)}`;
    const response = await create();
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'approved_calls_hash_mismatch');
  });

  test('a run belonging to another tenant is not found', async () => {
    // The body names the OTHER wallet, so it clears the session check and is
    // refused by the record lookup instead — which is the check under test.
    const response = await create({ ...body, walletAddress: OTHER_WALLET }, app(OTHER));
    assert.equal(response.status, 404);
    assert.equal(response.body.code, 'route_run_not_found');
  });

  test('the request carries no calls, calldata or receipts', async () => {
    // `.strict()` on the wire schema: an attempt to widen what recovery can
    // influence is a 400, not a silently ignored field.
    const response = await create({ ...body, calls: [{ to: WALLET, data: '0x' }] });
    assert.equal(response.status, 400);
  });
});

describe('binding a batch', () => {
  async function attemptId(): Promise<string> {
    const response = await create();
    return response.body.attempt.id as string;
  }

  test('the same batch twice succeeds both times', async () => {
    const id = await attemptId();
    const first = await request(app())
      .post(`/api/route-intelligence/submission-attempts/${id}/batch`)
      .send({ batchId: 'batch-1' });
    const second = await request(app())
      .post(`/api/route-intelligence/submission-attempts/${id}/batch`)
      .send({ batchId: 'batch-1' });
    assert.equal(first.status, 200);
    assert.equal(first.body.attempt.status, 'batch_observed');
    assert.equal(second.status, 200);
  });

  test('a different batch is a 409', async () => {
    const id = await attemptId();
    await request(app()).post(`/api/route-intelligence/submission-attempts/${id}/batch`).send({ batchId: 'batch-1' });
    const response = await request(app())
      .post(`/api/route-intelligence/submission-attempts/${id}/batch`)
      .send({ batchId: 'batch-2' });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'submission_attempt_conflict');
  });

  test("another tenant's attempt is indistinguishable from a missing one", async () => {
    const id = await attemptId();
    const foreign = await request(app(OTHER))
      .post(`/api/route-intelligence/submission-attempts/${id}/batch`)
      .send({ batchId: 'batch-1' });
    const missing = await request(app(OTHER))
      .post('/api/route-intelligence/submission-attempts/does-not-exist/batch')
      .send({ batchId: 'batch-1' });
    assert.equal(foreign.status, 404);
    assert.deepEqual(foreign.body, missing.body);
  });

  test('a transaction hash or receipt is not accepted here', async () => {
    const id = await attemptId();
    const response = await request(app())
      .post(`/api/route-intelligence/submission-attempts/${id}/batch`)
      .send({ batchId: 'batch-1', transactionHashes: [`0x${'11'.repeat(32)}`] });
    assert.equal(response.status, 400);
  });
});

describe('listing and abandoning', () => {
  test('the wallet comes from the session, never from the query', async () => {
    await create();
    const response = await request(app()).get(
      `/api/route-intelligence/submission-attempts/recoverable?walletAddress=${OTHER_WALLET}`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.attempts.length, 1);
    assert.equal(response.body.attempts[0].walletAddress, WALLET);
  });

  test('another tenant sees none of them', async () => {
    await create();
    const response = await request(app(OTHER)).get('/api/route-intelligence/submission-attempts/recoverable');
    assert.equal(response.body.attempts.length, 0);
  });

  test('abandoning removes the card and nothing else', async () => {
    const created = await create();
    const id = created.body.attempt.id as string;
    const response = await request(app()).post(`/api/route-intelligence/submission-attempts/${id}/abandon`);
    assert.equal(response.status, 200);
    assert.equal(response.body.attempt.status, 'abandoned');
    assert.ok(response.body.attempt.completedAt);
    const listed = await request(app()).get('/api/route-intelligence/submission-attempts/recoverable');
    assert.equal(listed.body.attempts.length, 0);
    // The proof is untouched: nothing in this router writes one.
    assert.equal(response.body.attempt.proofId, PROOF_ID);
  });

  test('abandoning an attempt that is not yours is a 404', async () => {
    const created = await create();
    const response = await request(app(OTHER)).post(
      `/api/route-intelligence/submission-attempts/${created.body.attempt.id}/abandon`,
    );
    assert.equal(response.status, 404);
  });
});

describe('the router cannot send anything', () => {
  test('no response ever carries calls, calldata or a wallet payload', async () => {
    const created = await create();
    const serialised = JSON.stringify(created.body).toLowerCase();
    for (const banned of ['calldata', 'sendcalls', 'approvedcalls"', 'privatekey', 'rawtransaction']) {
      assert.equal(serialised.includes(banned), false, `a recovery response must not carry ${banned}`);
    }
  });
});
