import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe } from 'node:test';
import express from 'express';
import request from 'supertest';
import {
  InMemoryPublicProofShareRepositoryV1,
  type NftStorageRepository,
  type RouteStorageRepository,
} from '@mioagent/route-storage';
import {
  PublicProofBundleV1Schema,
  hashPublicProofBundleV1,
  type RouteProofEventV1,
  type RouteProofV1,
} from '@mioagent/route-domain';
import { publicProofOwnerRouter, publicProofRouter, publicProofRuntime } from './publicProof.js';
import { routeProofFixtureV1 } from '../lib/publicProofFixture.js';

globalThis.fetch = (() => {
  throw new Error('live network call attempted in a unit test');
}) as unknown as typeof fetch;

const WALLET = '0x1111111111111111111111111111111111111111';
const USER = { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 as const };
const OTHER_WALLET = '0x2222222222222222222222222222222222222222';
const OTHER = { id: `eip155:8453:${OTHER_WALLET}`, address: OTHER_WALLET, chainId: 8453 as const };
const NOW = new Date('2026-07-27T12:00:00.000Z');

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
  submissionRecoveryV1: false,
  publicProofV1: true,
};

const original = { ...publicProofRuntime };
let shares: InMemoryPublicProofShareRepositoryV1;
let proof: RouteProofV1;
let events: RouteProofEventV1[];
let publicIdSequence: number;

function fakeRouteRepository(): RouteStorageRepository {
  return {
    async getProofProjection(id: string, userId: string) {
      return id === proof.id && userId === USER.id ? proof : null;
    },
    async listProofEvents(id: string, userId: string) {
      return id === proof.id && userId === USER.id ? events : [];
    },
  } as unknown as RouteStorageRepository;
}

function fakeNftRepository(): NftStorageRepository {
  return {
    async getNftProof() {
      return null;
    },
    async listNftProofEvents() {
      return [];
    },
  } as unknown as NftStorageRepository;
}

function ownerApp(user: typeof USER | null = USER) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    if (user) Object.defineProperty(req, 'session', { configurable: true, value: { user } });
    next();
  });
  server.use('/api/route-intelligence', publicProofOwnerRouter);
  return server;
}

/** Deliberately built with NO session middleware at all: if any public route
 * ever needed one, these tests would fail rather than pass by accident. */
function visitorApp() {
  const server = express();
  server.use('/api/public', publicProofRouter);
  return server;
}

beforeEach(() => {
  publicIdSequence = 0;
  shares = new InMemoryPublicProofShareRepositoryV1(() => {
    publicIdSequence += 1;
    return `${publicIdSequence}`.padStart(48, '0');
  });
  const fixture = routeProofFixtureV1({ tenantId: USER.id, walletAddress: WALLET, finalStatus: 'completed' });
  proof = fixture.proof;
  events = fixture.events;
  publicProofRuntime.flags = () => ({ ...FLAGS });
  publicProofRuntime.shares = () => shares;
  publicProofRuntime.routeRepository = fakeRouteRepository;
  publicProofRuntime.nftRepository = fakeNftRepository;
  publicProofRuntime.migrationAvailable = async () => true;
  publicProofRuntime.now = () => NOW;
});

afterEach(() => {
  Object.assign(publicProofRuntime, original);
});

function share(user: typeof USER | null = USER) {
  return request(ownerApp(user)).post(`/api/route-intelligence/route-proofs/${proof.id}/share`);
}

describe('publishing is explicit and owner-only', () => {
  test('a terminal proof can be shared', async () => {
    const response = await share();
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.match(response.body.publicId, /^[0-9a-f]{48,}$/);
    assert.equal(response.body.url, `/proof/${response.body.publicId}`);
  });

  test('a pending proof cannot be published', async () => {
    // Publishing a question Miorail has not answered would put a claim on the
    // internet that Miorail itself is not making.
    proof = { ...proof, finalStatus: 'pending' } as RouteProofV1;
    const response = await share();
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'proof_not_final');
  });

  test('a repeat Share returns the same link', async () => {
    const first = await share();
    const second = await share();
    assert.equal(first.body.publicId, second.body.publicId);
  });

  test("another tenant cannot publish somebody else's proof", async () => {
    const response = await share(OTHER);
    assert.equal(response.status, 404);
  });

  test('an unauthenticated caller cannot publish', async () => {
    assert.equal((await share(null)).status, 401);
  });

  test('the flag off makes the route not exist', async () => {
    publicProofRuntime.flags = () => ({ ...FLAGS, publicProofV1: false });
    assert.equal((await share()).status, 404);
  });
});

describe('the public read needs no session', () => {
  async function publish(): Promise<string> {
    const response = await share();
    return response.body.publicId as string;
  }

  test('a visitor with the link gets the bundle', async () => {
    const publicId = await publish();
    const response = await request(visitorApp()).get(`/api/public/proofs/${publicId}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.bundle.publicProofId, publicId);
    assert.equal(response.body.bundle.proofFamily, 'route');
  });

  test('the bundle parses against its own schema and carries the canonical proof', async () => {
    const publicId = await publish();
    const response = await request(visitorApp()).get(`/api/public/proofs/${publicId}`);
    const bundle = PublicProofBundleV1Schema.parse(response.body.bundle);
    // The canonical document, not a projection: proofHash is recomputable.
    assert.equal(bundle.proof.proofHash, proof.proofHash);
    assert.ok(bundle.events.length > 0);
  });

  test('two fetches are byte-identical', async () => {
    // Otherwise "download it and check the hash" is not something anyone can do.
    const publicId = await publish();
    const first = await request(visitorApp()).get(`/api/public/proofs/${publicId}/bundle`);
    const second = await request(visitorApp()).get(`/api/public/proofs/${publicId}/bundle`);
    assert.equal(first.text, second.text);
  });

  test('the bundle downloads under its public id, and is never cached', async () => {
    const publicId = await publish();
    const response = await request(visitorApp()).get(`/api/public/proofs/${publicId}/bundle`);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.match(response.headers['content-disposition'] ?? '', new RegExp(`miorail-proof-${publicId}\\.json`));
    assert.match(response.headers['x-robots-tag'] ?? '', /noindex/);
  });

  test('changing one byte of the bundle breaks its hash', async () => {
    const publicId = await publish();
    const response = await request(visitorApp()).get(`/api/public/proofs/${publicId}/bundle`);
    const bundle = JSON.parse(response.text) as Record<string, unknown>;
    assert.equal(hashPublicProofBundleV1(bundle), bundle.bundleHash);
    const tampered = { ...bundle, issuedAt: '2020-01-01T00:00:00.000Z' };
    assert.notEqual(hashPublicProofBundleV1(tampered), bundle.bundleHash);
    assert.throws(() => PublicProofBundleV1Schema.parse(tampered));
  });

  test('an unknown id and a revoked id are the same answer', async () => {
    const publicId = await publish();
    await request(ownerApp()).delete(`/api/route-intelligence/route-proofs/${proof.id}/share`);
    const revoked = await request(visitorApp()).get(`/api/public/proofs/${publicId}`);
    const unknown = await request(visitorApp()).get(`/api/public/proofs/${'f'.repeat(48)}`);
    assert.equal(revoked.status, 404);
    assert.equal(unknown.status, 404);
    assert.deepEqual(revoked.body, unknown.body);
  });

  test('revoking is immediate and idempotent, and a new share gets a NEW id', async () => {
    const first = await publish();
    const revokeOne = await request(ownerApp()).delete(`/api/route-intelligence/route-proofs/${proof.id}/share`);
    const revokeTwo = await request(ownerApp()).delete(`/api/route-intelligence/route-proofs/${proof.id}/share`);
    assert.equal(revokeOne.body.revoked, true);
    assert.equal(revokeTwo.body.revoked, false);
    const second = await publish();
    assert.notEqual(second, first, 'a revoked id is never reissued');
    assert.equal((await request(visitorApp()).get(`/api/public/proofs/${first}`)).status, 404);
  });

  test('a non-owner cannot revoke', async () => {
    const publicId = await publish();
    await request(ownerApp(OTHER)).delete(`/api/route-intelligence/route-proofs/${proof.id}/share`);
    assert.equal((await request(visitorApp()).get(`/api/public/proofs/${publicId}`)).status, 200);
  });

  test('the flag off makes the public route not exist', async () => {
    const publicId = await publish();
    publicProofRuntime.flags = () => ({ ...FLAGS, publicProofV1: false });
    assert.equal((await request(visitorApp()).get(`/api/public/proofs/${publicId}`)).status, 404);
  });
});

describe('nothing private leaves with the bundle', () => {
  test('no session, token, key, email or prompt appears anywhere in it', async () => {
    const response = await share();
    const bundle = await request(visitorApp()).get(`/api/public/proofs/${response.body.publicId}/bundle`);
    const serialised = bundle.text.toLowerCase();
    for (const banned of ['cookie', 'session', 'siwe', 'authorization', 'apikey', 'api_key', 'bearer', '@', 'prompt']) {
      assert.equal(serialised.includes(banned), false, `a public bundle must not carry ${banned}`);
    }
  });

  test('the wallet address and transaction hashes DO appear, which is the point', async () => {
    // They are what makes the proof checkable on a block explorer. The UI warns
    // about exactly this before anything is published.
    const response = await share();
    const bundle = await request(visitorApp()).get(`/api/public/proofs/${response.body.publicId}/bundle`);
    assert.ok(bundle.text.includes(WALLET));
    assert.ok(bundle.text.includes(proof.transactionHashes[0] ?? ''));
  });
});
