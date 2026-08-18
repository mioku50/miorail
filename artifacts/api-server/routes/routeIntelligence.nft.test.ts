import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe } from 'node:test';
import express from 'express';
import request from 'supertest';
import { createMemoryNftStorageRepository, type NftStorageRepository } from '@mioagent/route-storage';
import type { NftChainReaderV1, NftObservedListingV1, OpenSeaGatewayV1 } from '@mioagent/nft-engine';
import { ERC721_TRANSFER_TOPIC_V1 } from '@mioagent/nft-engine';
import { routeIntelligenceRouter } from './routeIntelligence.js';
import { nftRouteRuntime } from './nftRouteIntelligence.js';

// A detonator on the global fetch: every OpenSea and RPC seam is injected, so
// a test that forgets to stub one fails loudly instead of opening a socket.
globalThis.fetch = (() => {
  throw new Error('live network call attempted in a unit test');
}) as unknown as typeof fetch;

// ---------------------------------------------------------------------------
// T65.1 §7 — the NFT routes end to end, with every seam faked.
//
// What these hold in place is the boundary the whole family rests on: the
// client sends a goal, a card hash, and the hash of the calls it reviewed —
// never calldata, a target, a value or a recipient — and no purchase is called
// completed without an ownership read.
// ---------------------------------------------------------------------------

const WALLET = '0x1111111111111111111111111111111111111111';
const USER = { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 as const };
const OTHER_WALLET = '0x2222222222222222222222222222222222222222';
const OTHER_USER = { id: `eip155:8453:${OTHER_WALLET}`, address: OTHER_WALLET, chainId: 8453 as const };

const SELLER = '0x4efca7cc8058d5acd2bb2ccd2a9430906291cdd6' as const;
const COLLECTION = '0x41dc69132cce31fcbf6755c84538ca268520246f' as const;
const TOKEN_ID = '16668';
const SEAPORT = '0x0000000000000068f116a894984e2db1123eb395' as const;
const PRICE = '3580000000000000';
const TX = `0x${'f'.repeat(64)}` as `0x${string}`;
const NOW = new Date('2026-07-26T12:00:00.000Z');
const H = (c: string) => `0x${c.repeat(64)}` as `0x${string}`;

const FLAGS = {
  routeIntelligenceV1: true,
  legacyTerminal: true,
  paidIntelligence: false,
  earnRouteV1: false,
  commerceRouteV1: false,
  commerceExecutionV1: false,
  nftRouteV1: true,
  nftExecutionV1: true, privateAiRouteV1: false, privateAiExecutionV1: false, aerodromeExecutionV1: false, b20ControlV1: false, b20PublicContextV1: false, submissionRecoveryV1: false, publicProofV1: false, mcpPrivateV1: false, mcpPrivateExecutionV1: false, routeOutcomeFeedbackV1: false, tokenIdentityV1: false,
};

const originalRuntime = { ...nftRouteRuntime };
const originalChainEnv = process.env.CHAIN_ENV;

const GOAL = 'Buy NFT BasePaint #16668 under 0.02 ETH on Base';
/** The same purchase named by contract, which needs no slug resolution. */
const CONTRACT_GOAL = `Buy NFT ${COLLECTION} #${TOKEN_ID} for no more than 0.02 ETH`;

let repository: NftStorageRepository;
let listing: NftObservedListingV1;
let fulfillmentPayload: unknown;
let simulationStatus: 'passed' | 'failed' | 'unavailable';
let chainReads: { transaction: unknown; owner: unknown };

function routeApp(user: typeof USER | null = USER) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) Object.defineProperty(req, 'session', { configurable: true, value: { user } });
    next();
  });
  app.use('/api/route-intelligence', routeIntelligenceRouter);
  return app;
}

function baseListing(): NftObservedListingV1 {
  return {
    orderHash: H('c'),
    protocolAddress: SEAPORT,
    seller: SELLER,
    contractAddress: COLLECTION,
    tokenId: TOKEN_ID,
    totalWei: PRICE,
    feeWei: '35800000000000',
    listingStatus: 'active',
    listingExpiresAt: '2026-07-27T11:43:50.000Z',
    restrictedByZone: false,
    requestHash: H('d'),
    responseHash: H('e'),
    observedAt: '2026-07-26T11:59:50.000Z',
  };
}

function basicFulfillment(paramOverrides: Record<string, unknown> = {}) {
  return {
    protocol: 'seaport1.6',
    fulfillment_data: {
      transaction: {
        function:
          'fulfillBasicOrder_efficient_6GL6yc((address,uint256,uint256,address,address,address,uint256,uint256,uint8,uint256,uint256,bytes32,uint256,bytes32,bytes32,uint256,(uint256,address)[],bytes))',
        chain: 8453,
        to: SEAPORT,
        value: PRICE,
        input_data: {
          parameters: {
            considerationToken: '0x0000000000000000000000000000000000000000',
            considerationIdentifier: '0',
            considerationAmount: '3544200000000000',
            offerer: SELLER,
            zone: '0x0000000000000000000000000000000000000000',
            offerToken: COLLECTION,
            offerIdentifier: TOKEN_ID,
            offerAmount: '1',
            basicOrderType: 0,
            startTime: '1785066231',
            endTime: '99999999999',
            zoneHash: H('0'),
            salt: '1',
            offererConduitKey: H('0'),
            fulfillerConduitKey: H('0'),
            totalOriginalAdditionalRecipients: '1',
            additionalRecipients: [{ amount: '35800000000000', recipient: '0x0000a26b00c1f0df003000390027140000faa719' }],
            signature: `0x${'ab'.repeat(65)}`,
            ...paramOverrides,
          },
        },
      },
      orders: [],
    },
  };
}

function gateway(): OpenSeaGatewayV1 {
  return {
    async readNft() {
      return {
        ok: true as const,
        value: {
          contractAddress: COLLECTION,
          tokenId: TOKEN_ID,
          tokenStandard: 'erc721',
          collectionSlug: 'dxterminal',
          name: 'IzioGh0st',
          imageUrl: null,
          isDisabled: false,
          isNsfw: false,
          requestHash: H('a'),
          responseHash: H('b'),
          observedAt: '2026-07-26T11:59:50.000Z',
        },
      };
    },
    async readContract() {
      return { ok: true as const, value: { address: COLLECTION, collectionSlug: 'dxterminal', standard: 'erc721' } };
    },
    async readBestListing() {
      return { ok: true as const, value: listing };
    },
    async readOrder() {
      return { ok: true as const, value: listing };
    },
    async readFulfillment() {
      return { ok: true as const, value: fulfillmentPayload };
    },
  };
}

function chainReader(): NftChainReaderV1 {
  return {
    async readTransaction() {
      return chainReads.transaction as never;
    },
    async readOwnerOf() {
      return chainReads.owner as never;
    },
  };
}

function transferLog(to: string) {
  const topic = (address: string) => `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
  return {
    address: COLLECTION,
    topics: [ERC721_TRANSFER_TOPIC_V1, topic(SELLER), topic(to), `0x${BigInt(TOKEN_ID).toString(16).padStart(64, '0')}`],
    data: '0x',
  };
}

beforeEach(() => {
  repository = createMemoryNftStorageRepository(() => NOW);
  listing = baseListing();
  fulfillmentPayload = basicFulfillment();
  simulationStatus = 'passed';
  chainReads = { transaction: null, owner: null };
  process.env.CHAIN_ENV = 'mainnet';
  nftRouteRuntime.flags = () => ({ ...FLAGS });
  nftRouteRuntime.now = () => NOW;
  nftRouteRuntime.repository = () => repository;
  nftRouteRuntime.migrationAvailable = async () => true;
  nftRouteRuntime.gateway = () => gateway();
  nftRouteRuntime.chainReader = () => chainReader();
  nftRouteRuntime.config = () => ({
    openSeaApiKey: 'test-key',
    configured: true,
    timeoutMs: 8_000,
    listingTtlMs: 30_000,
    imageAllowed: false,
  });
  nftRouteRuntime.simulate = async () => ({
    status: simulationStatus,
    observedAt: NOW.toISOString(),
    blockNumber: simulationStatus === 'unavailable' ? null : '30000000',
    requestHash: H('1') as `0x${string}`,
    responseHash: simulationStatus === 'unavailable' ? null : (H('2') as `0x${string}`),
    errorCode: simulationStatus === 'passed' ? null : simulationStatus === 'failed' ? 'reverted' : 'provider_not_configured',
  });
});

afterEach(() => {
  Object.assign(nftRouteRuntime, originalRuntime);
  if (originalChainEnv === undefined) delete process.env.CHAIN_ENV;
  else process.env.CHAIN_ENV = originalChainEnv;
});

async function compare(app = routeApp(), requestId = 'nft-req-1') {
  return request(app)
    .post('/api/route-intelligence/nft/compare')
    .send({ message: GOAL, walletAddress: WALLET, requestId });
}

async function prepared(requestId = 'nft-req-1') {
  const app = routeApp();
  const compared = await compare(app, requestId);
  const { routeRunId, routeCard } = compared.body;
  const prepare = await request(app)
    .post('/api/route-intelligence/nft/prepare')
    .send({ routeRunId, routeCardHash: routeCard.routeCardHash, walletAddress: WALLET });
  return { app, routeRunId, routeCard, prepare };
}

/** Prepare, then approve exactly the way the SHARED submission hook does —
 * naming the blueprint by hash and never naming a calls hash of its own. */
async function approvedFlow(requestId = 'nft-req-1') {
  const { app, routeRunId, prepare } = await prepared(requestId);
  const approve = await request(app)
    .post(`/api/route-intelligence/nft/blueprints/${prepare.body.blueprintId}/approve`)
    .send({ routeRunId, blueprintHash: prepare.body.blueprint.blueprintHash, walletAddress: WALLET });
  return { app, routeRunId, prepare, approve };
}

/** The goal-agnostic submission record the shared hook posts. */
function submissionBody(routeRunId: string, approvedCallsHash: string, over: Record<string, unknown> = {}) {
  const body: Record<string, unknown> = {
    routeRunId,
    walletAddress: WALLET,
    approvedCallsHash,
    status: 'submitted',
    batchId: 'batch-1',
    transactionHashes: [TX],
    ...over,
  };
  for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
  return body;
}

describe('compare persists what it found', () => {
  test('a live listing produces a stored run and a ready card', async () => {
    const response = await compare();
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'compared');
    assert.equal(response.body.routeCard.status, 'ready');
    assert.equal(response.body.routeCard.asset.tokenId, TOKEN_ID);
    assert.equal(response.body.routeCard.candidate.listingPriceWei, PRICE);
    // The image policy is off in this fixture, so no URL reaches the surface.
    assert.equal(response.body.routeCard.asset.display.imageUrl, null);
  });

  test('the NFT gate being off is a 404, not a swap comparison', async () => {
    nftRouteRuntime.flags = () => ({ ...FLAGS, nftRouteV1: false });
    const response = await compare();
    assert.equal(response.status, 404);
    assert.equal(response.body.code, 'nft_route_disabled');
  });

  test('an unauthenticated caller is refused', async () => {
    const response = await request(routeApp(null))
      .post('/api/route-intelligence/nft/compare')
      .send({ message: GOAL, walletAddress: WALLET, requestId: 'x' });
    assert.equal(response.status, 401);
  });

  test('a wallet that is not the session wallet is refused', async () => {
    const response = await request(routeApp())
      .post('/api/route-intelligence/nft/compare')
      .send({ message: GOAL, walletAddress: OTHER_WALLET, requestId: 'x' });
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'wallet_mismatch');
  });

  test('an unlisted NFT named by CONTRACT still returns a card naming the token', async () => {
    nftRouteRuntime.gateway = () => ({
      ...gateway(),
      async readBestListing() {
        return { ok: false, reason: 'not_found' };
      },
    });
    const response = await request(routeApp())
      .post('/api/route-intelligence/nft/compare')
      .send({ message: CONTRACT_GOAL, walletAddress: WALLET, requestId: 'nft-req-contract' });
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'unavailable');
    assert.equal(response.body.reason, 'no_active_listing');
    assert.equal(response.body.routeCard.candidate, null);
    assert.equal(response.body.routeCard.asset.tokenId, TOKEN_ID);
  });

  test('an unlisted NFT named only by SLUG cannot produce a card', async () => {
    // The slug is resolved to a contract THROUGH the listing. With no listing
    // there is no contract, so there is no token to name — and saying nothing
    // beats naming a token nobody identified.
    nftRouteRuntime.gateway = () => ({
      ...gateway(),
      async readBestListing() {
        return { ok: false, reason: 'not_found' };
      },
    });
    const response = await compare();
    assert.equal(response.body.outcome, 'unsupported');
    assert.match(response.body.reason, /not listed for sale/);
  });
});

describe('comparing the same NFT twice is two observations', () => {
  /** What the console actually does: every click is its own comparison. */
  async function compareAgain(requestId: string, at: Date) {
    nftRouteRuntime.now = () => at;
    listing = { ...baseListing(), observedAt: at.toISOString() };
    return request(routeApp())
      .post('/api/route-intelligence/nft/compare')
      .send({ message: GOAL, walletAddress: WALLET, requestId });
  }

  test('a second look at the same listing succeeds and gets its own run', async () => {
    // The defect this replaces: the client reused one request id for the same
    // goal, so the second observation landed in the FIRST run, collided with
    // its candidate (one per order, by unique index) and failed with a 409 that
    // explained none of it. A listing is not a stable fact — re-comparing is a
    // new observation, and it gets a new run.
    const first = await compareAgain('nft-req-a', NOW);
    const second = await compareAgain('nft-req-b', new Date(NOW.getTime() + 20_000));
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.body.outcome, 'compared');
    assert.notEqual(second.body.routeRunId, first.body.routeRunId);
    // Each run holds its own evidence for its own observation.
    assert.equal((await repository.listNftCandidates(first.body.routeRunId, USER.id)).length, 1);
    assert.equal((await repository.listNftCandidates(second.body.routeRunId, USER.id)).length, 1);
  });

  test('the second run stores its OWN candidate, evidence and card', async () => {
    // The production failure this replaces: candidate, evidence and card ids
    // were derived from the intent HASH, which is deliberately identical for
    // the same goal. A second comparison therefore minted rows whose primary
    // keys already existed in the first run, the inserts were dropped, and the
    // evidence insert failed with "NFT evidence references an unknown
    // candidate". Ids are scoped to the run now.
    const first = await compareAgain('nft-req-a', NOW);
    const second = await compareAgain('nft-req-b', new Date(NOW.getTime() + 20_000));
    assert.equal(second.status, 200);

    const [firstCandidate] = await repository.listNftCandidates(first.body.routeRunId, USER.id);
    const [secondCandidate] = await repository.listNftCandidates(second.body.routeRunId, USER.id);
    assert.ok(firstCandidate && secondCandidate);
    assert.notEqual(secondCandidate.id, firstCandidate.id, 'each run owns its candidate row');
    assert.notEqual(second.body.routeCard.id, first.body.routeCard.id, 'and its card row');

    const firstEvidence = await repository.listNftEvidence(first.body.routeRunId, USER.id);
    const secondEvidence = await repository.listNftEvidence(second.body.routeRunId, USER.id);
    assert.ok(firstEvidence.length > 0);
    assert.equal(secondEvidence.length, firstEvidence.length, 'the second observation kept all of its evidence');
    const shared = secondEvidence.filter((record) => firstEvidence.some((other) => other.id === record.id));
    assert.deepEqual(shared, [], 'no evidence row is shared between two observations');
  });

  test('an identical replay of ONE request id returns the same run, not a second', async () => {
    const first = await compareAgain('nft-req-same', NOW);
    const replay = await compareAgain('nft-req-same', NOW);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.routeRunId, first.body.routeRunId);
    assert.equal(replay.body.routeCard.routeCardHash, first.body.routeCard.routeCardHash);
    assert.equal((await repository.listNftCandidates(first.body.routeRunId, USER.id)).length, 1);
  });

  test('a MOVED listing replayed under one request id is refused with a stated reason', async () => {
    // Not silently kept at the old price: the run already answered for this
    // order, and a different answer for the same order is a conflict.
    await compareAgain('nft-req-moved', NOW);
    nftRouteRuntime.now = () => new Date(NOW.getTime() + 20_000);
    listing = { ...baseListing(), totalWei: '9999000000000000' };
    const moved = await request(routeApp())
      .post('/api/route-intelligence/nft/compare')
      .send({ message: GOAL, walletAddress: WALLET, requestId: 'nft-req-moved' });
    assert.equal(moved.status, 409);
    assert.match(moved.body.detail, /different candidate in this run/);
  });
});

describe('prepare loads the reviewed card, and refuses a moved listing', () => {
  test('a basic order prepares and is signable when every gate passes', async () => {
    const { prepare } = await prepared();
    assert.equal(prepare.status, 200);
    assert.equal(prepare.body.outcome, 'prepared');
    assert.equal(prepare.body.signable, true);
    assert.equal(prepare.body.safety.ok, true);
    assert.equal(prepare.body.blueprint.calls.length, 1);
    assert.equal(prepare.body.blueprint.calls[0].valueWei, PRICE);
    // Confirms the basic encoder ran: fulfillBasicOrder_efficient_6GL6yc.
    assert.equal(prepare.body.blueprint.calls[0].data.slice(0, 10), '0x00000000');
  });

  test('a second prepare returns the SAME blueprint, not a second wallet prompt', async () => {
    const { app, routeRunId, routeCard, prepare } = await prepared();
    const again = await request(app)
      .post('/api/route-intelligence/nft/prepare')
      .send({ routeRunId, routeCardHash: routeCard.routeCardHash, walletAddress: WALLET });
    assert.equal(again.body.blueprintId, prepare.body.blueprintId);
    assert.equal(again.body.blueprint.callsHash, prepare.body.blueprint.callsHash);
  });

  test('an unknown card hash is a 404, never a fresh comparison', async () => {
    const app = routeApp();
    const compared = await compare(app);
    const response = await request(app)
      .post('/api/route-intelligence/nft/prepare')
      .send({ routeRunId: compared.body.routeRunId, routeCardHash: H('9'), walletAddress: WALLET });
    assert.equal(response.status, 404);
    assert.equal(response.body.code, 'nft_route_card_not_found');
  });

  test("another tenant cannot prepare against someone else's run", async () => {
    const compared = await compare();
    const response = await request(routeApp(OTHER_USER))
      .post('/api/route-intelligence/nft/prepare')
      .send({
        routeRunId: compared.body.routeRunId,
        routeCardHash: compared.body.routeCard.routeCardHash,
        walletAddress: OTHER_WALLET,
      });
    assert.equal(response.status, 404);
  });

  test('a price that moved between comparing and preparing ends the flow', async () => {
    const app = routeApp();
    const compared = await compare(app);
    // Cheaper is refused too: a different number is a different purchase than
    // the one that was reviewed.
    listing = { ...baseListing(), totalWei: '3000000000000000' };
    const response = await request(app)
      .post('/api/route-intelligence/nft/prepare')
      .send({
        routeRunId: compared.body.routeRunId,
        routeCardHash: compared.body.routeCard.routeCardHash,
        walletAddress: WALLET,
      });
    assert.equal(response.body.outcome, 'rejected');
  });

  test('a listing that stopped being active is refused', async () => {
    const app = routeApp();
    const compared = await compare(app);
    listing = { ...baseListing(), listingStatus: 'cancelled' };
    const response = await request(app)
      .post('/api/route-intelligence/nft/prepare')
      .send({
        routeRunId: compared.body.routeRunId,
        routeCardHash: compared.body.routeCard.routeCardHash,
        walletAddress: WALLET,
      });
    assert.equal(response.body.outcome, 'rejected');
  });

  test('a fulfilment naming a different token is refused, not encoded', async () => {
    const app = routeApp();
    const compared = await compare(app);
    fulfillmentPayload = basicFulfillment({ offerIdentifier: '99999' });
    const response = await request(app)
      .post('/api/route-intelligence/nft/prepare')
      .send({
        routeRunId: compared.body.routeRunId,
        routeCardHash: compared.body.routeCard.routeCardHash,
        walletAddress: WALLET,
      });
    assert.equal(response.body.outcome, 'rejected');
    assert.equal(response.body.reason, 'order_mismatch');
  });

  test('a reverting simulation is not signable', async () => {
    simulationStatus = 'failed';
    const { prepare } = await prepared();
    assert.equal(prepare.body.signable, false);
    assert.match(prepare.body.blockedReason, /reverts in simulation/);
  });

  test('an unavailable simulation is not signable either — absence never signs', async () => {
    simulationStatus = 'unavailable';
    const { prepare } = await prepared();
    assert.equal(prepare.body.signable, false);
    assert.match(prepare.body.blockedReason, /Simulation has not run/);
  });

  test('the purchase gate being off makes nothing signable', async () => {
    nftRouteRuntime.flags = () => ({ ...FLAGS, nftExecutionV1: false, privateAiRouteV1: false, privateAiExecutionV1: false, aerodromeExecutionV1: false, b20ControlV1: false, b20PublicContextV1: false, submissionRecoveryV1: false, publicProofV1: false, mcpPrivateV1: false, mcpPrivateExecutionV1: false, routeOutcomeFeedbackV1: false, tokenIdentityV1: false, });
    const { prepare } = await prepared();
    assert.equal(prepare.body.signable, false);
    assert.match(prepare.body.blockedReason, /execution is off/i);
  });
});

describe('approval is of these calls, and submission happens once', () => {
  test('the approve response IS the canonical wallet payload the shared hook consumes', async () => {
    const { approve, prepare } = await approvedFlow();
    assert.equal(approve.status, 200);
    assert.equal(approve.body.outcome, 'approved');
    const payload = approve.body.payload;
    // Every field useSubmitApprovedBlueprint + blueprintSubmitPreflight read.
    assert.equal(payload.goal, 'nft');
    assert.equal(payload.chainId, '0x2105');
    assert.equal(payload.from, WALLET);
    assert.equal(payload.atomicRequired, true);
    assert.equal(payload.calls.length, 1);
    assert.equal(payload.calls[0].to, SEAPORT);
    assert.equal(BigInt(payload.calls[0].value).toString(), PRICE);
    assert.equal(payload.blueprintHash, prepare.body.blueprint.blueprintHash);
    assert.equal(payload.approvedCallsHash, prepare.body.blueprint.callsHash);
    // …and NOTHING NFT-specific rides along in the wallet transport.
    assert.equal(approve.body.blueprint, undefined);
    assert.equal(approve.body.proofId, undefined);
    assert.equal(Object.keys(payload).sort().join(','),
      'approvedCallsHash,atomicRequired,blueprintHash,blueprintId,calls,chainId,from,goal');
  });

  test('approving a blueprint hash that is not the stored one is blocked', async () => {
    const { app, routeRunId, prepare } = await prepared();
    const response = await request(app)
      .post(`/api/route-intelligence/nft/blueprints/${prepare.body.blueprintId}/approve`)
      .send({ routeRunId, blueprintHash: H('7'), walletAddress: WALLET });
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'blocked');
    assert.deepEqual(response.body.safety.violations, ['blueprint_hash_mismatch']);
    // Nothing was approved, so nothing can be submitted.
    const stored = await repository.getNftPurchaseBlueprint(prepare.body.blueprintId, USER.id);
    assert.equal(stored?.blueprint.approvedCallsHash, null);
  });

  test('an expired review cannot be approved', async () => {
    const { app, routeRunId, prepare } = await prepared();
    nftRouteRuntime.now = () => new Date(Date.parse(prepare.body.blueprint.expiresAt) + 1_000);
    const response = await request(app)
      .post(`/api/route-intelligence/nft/blueprints/${prepare.body.blueprintId}/approve`)
      .send({ routeRunId, blueprintHash: prepare.body.blueprint.blueprintHash, walletAddress: WALLET });
    assert.equal(response.body.outcome, 'expired');
  });

  test('a second approve after submission is blocked, not a second wallet prompt', async () => {
    const { app, routeRunId, prepare, approve } = await approvedFlow();
    await request(app)
      .post(`/api/route-intelligence/nft/blueprints/${prepare.body.blueprintId}/submission`)
      .send(submissionBody(routeRunId, approve.body.payload.approvedCallsHash));
    const again = await request(app)
      .post(`/api/route-intelligence/nft/blueprints/${prepare.body.blueprintId}/approve`)
      .send({ routeRunId, blueprintHash: prepare.body.blueprint.blueprintHash, walletAddress: WALLET });
    assert.equal(again.body.outcome, 'blocked');
    assert.deepEqual(again.body.safety.violations, ['already_submitted']);
  });

  test('submission opens a pending proof carrying the hash to watch', async () => {
    const { app, routeRunId, prepare, approve } = await approvedFlow();
    const response = await request(app)
      .post(`/api/route-intelligence/nft/blueprints/${prepare.body.blueprintId}/submission`)
      .send(submissionBody(routeRunId, approve.body.payload.approvedCallsHash));
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'recorded');
    assert.equal(response.body.lifecycle, 'submitted');
    assert.equal(response.body.finalStatus, 'pending');
    const proof = await request(app).get(`/api/route-intelligence/nft/proofs/${response.body.proofId}`);
    assert.equal(proof.body.proof.receipt.transactionHash, TX);
    assert.equal(proof.body.needsReconciliation, true);
    assert.match(proof.body.copy, /Nothing is confirmed yet/);
  });

  test('a duplicate submission returns the same proof and appends no second event', async () => {
    // What a page refresh looks like from here: the same claim, again.
    const { app, routeRunId, prepare, approve } = await approvedFlow();
    const body = submissionBody(routeRunId, approve.body.payload.approvedCallsHash);
    const first = await request(app)
      .post(`/api/route-intelligence/nft/blueprints/${prepare.body.blueprintId}/submission`)
      .send(body);
    const second = await request(app)
      .post(`/api/route-intelligence/nft/blueprints/${prepare.body.blueprintId}/submission`)
      .send(body);
    assert.equal(second.status, 200);
    assert.equal(second.body.proofId, first.body.proofId);
    const events = await repository.listNftProofEvents(first.body.proofId, USER.id);
    assert.equal(events.length, 1);
    const stored = await repository.getNftPurchaseBlueprint(prepare.body.blueprintId, USER.id);
    assert.equal(stored?.submissionBatchId, 'batch-1');
  });

  test('a second, DIFFERENT batch for the same blueprint is a 409', async () => {
    const { app, routeRunId, prepare, approve } = await approvedFlow();
    const hash = approve.body.payload.approvedCallsHash;
    await request(app)
      .post(`/api/route-intelligence/nft/blueprints/${prepare.body.blueprintId}/submission`)
      .send(submissionBody(routeRunId, hash));
    const conflicting = await request(app)
      .post(`/api/route-intelligence/nft/blueprints/${prepare.body.blueprintId}/submission`)
      .send(submissionBody(routeRunId, hash, { batchId: 'batch-2', transactionHashes: [H('9')] }));
    assert.equal(conflicting.status, 409);
  });

  test('a record naming calls that were never approved is refused', async () => {
    const { app, routeRunId, prepare, approve } = await approvedFlow();
    assert.equal(approve.body.outcome, 'approved');
    const response = await request(app)
      .post(`/api/route-intelligence/nft/blueprints/${prepare.body.blueprintId}/submission`)
      .send(submissionBody(routeRunId, H('8')));
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'nft_approved_calls_mismatch');
  });

  test('a submission without an approval is refused', async () => {
    const { app, routeRunId, prepare } = await prepared();
    const response = await request(app)
      .post(`/api/route-intelligence/nft/blueprints/${prepare.body.blueprintId}/submission`)
      .send(submissionBody(routeRunId, prepare.body.blueprint.callsHash));
    assert.equal(response.status, 409);
  });

  test('a wallet rejection is recorded as cancelled, and opens no proof', async () => {
    const { app, routeRunId, prepare, approve } = await approvedFlow();
    const response = await request(app)
      .post(`/api/route-intelligence/nft/blueprints/${prepare.body.blueprintId}/submission`)
      .send(
        submissionBody(routeRunId, approve.body.payload.approvedCallsHash, {
          status: 'cancelled',
          batchId: undefined,
          transactionHashes: undefined,
          error: 'User rejected the request in the wallet',
        }),
      );
    assert.equal(response.status, 200);
    assert.equal(response.body.lifecycle, 'cancelled');
    // Nothing was sent, so there is no ownership question to answer.
    assert.equal(response.body.proofId, null);
    assert.equal(response.body.finalStatus, null);
    const blueprint = await repository.getNftPurchaseBlueprint(prepare.body.blueprintId, USER.id);
    assert.equal(blueprint?.submittedAt, null);
    assert.equal(blueprint?.submissionBatchId, null);
    assert.equal(await repository.getNftProofByBlueprint(prepare.body.blueprintId, USER.id), null);
  });

  test('a batch that went out cannot later be recorded as cancelled', async () => {
    const { app, routeRunId, prepare, approve } = await approvedFlow();
    const hash = approve.body.payload.approvedCallsHash;
    await request(app)
      .post(`/api/route-intelligence/nft/blueprints/${prepare.body.blueprintId}/submission`)
      .send(submissionBody(routeRunId, hash));
    const response = await request(app)
      .post(`/api/route-intelligence/nft/blueprints/${prepare.body.blueprintId}/submission`)
      .send(submissionBody(routeRunId, hash, { status: 'cancelled', batchId: undefined, transactionHashes: undefined }));
    assert.equal(response.status, 409);
  });

  test('a batch with no readable outcome is recorded as submitted_unknown, not submitted', async () => {
    const { app, routeRunId, prepare, approve } = await approvedFlow();
    const response = await request(app)
      .post(`/api/route-intelligence/nft/blueprints/${prepare.body.blueprintId}/submission`)
      .send(
        submissionBody(routeRunId, approve.body.payload.approvedCallsHash, {
          status: 'submitted_unknown',
          transactionHashes: undefined,
        }),
      );
    assert.equal(response.body.lifecycle, 'submitted_unknown');
    // Still pending: an unreadable batch is not a failure and not a purchase.
    assert.equal(response.body.finalStatus, 'pending');
  });

  test('another wallet cannot record against this blueprint', async () => {
    const { routeRunId, prepare, approve } = await approvedFlow();
    const response = await request(routeApp(OTHER_USER))
      .post(`/api/route-intelligence/nft/blueprints/${prepare.body.blueprintId}/submission`)
      .send(submissionBody(routeRunId, approve.body.payload.approvedCallsHash, { walletAddress: OTHER_WALLET }));
    assert.equal(response.status, 404);
  });
});

describe('reconciliation decides what happened', () => {
  async function submitted() {
    const { app, routeRunId, prepare, approve } = await approvedFlow();
    const submission = await request(app)
      .post(`/api/route-intelligence/nft/blueprints/${prepare.body.blueprintId}/submission`)
      .send(submissionBody(routeRunId, approve.body.payload.approvedCallsHash));
    return { app, proofId: submission.body.proofId as string };
  }

  test('receipt + Transfer + ownerOf agreeing is completed', async () => {
    const { app, proofId } = await submitted();
    chainReads = {
      transaction: {
        receipt: { status: 'success', transactionHash: TX, blockNumber: 30_000_000n, gasUsed: 210_000n, logs: [transferLog(WALLET)] },
        actualNativeValueWei: PRICE,
      },
      owner: { owner: WALLET, blockNumber: '30000001' },
    };
    const response = await request(app).post(`/api/route-intelligence/nft/proofs/${proofId}/reconcile`).send({});
    assert.equal(response.status, 200);
    assert.equal(response.body.proof.finalStatus, 'completed');
    assert.equal(response.body.needsReconciliation, false);
    assert.match(response.body.copy, /you own it/);
  });

  test('a succeeded receipt with no ownership stays open and says so', async () => {
    const { app, proofId } = await submitted();
    chainReads = {
      transaction: {
        receipt: { status: 'success', transactionHash: TX, blockNumber: 30_000_000n, gasUsed: 210_000n, logs: [] },
        actualNativeValueWei: PRICE,
      },
      owner: null,
    };
    const response = await request(app).post(`/api/route-intelligence/nft/proofs/${proofId}/reconcile`).send({});
    assert.equal(response.body.proof.finalStatus, 'reconciliation_required');
    assert.equal(response.body.needsReconciliation, true);
    assert.match(response.body.copy, /not a completed purchase/);
  });

  test('a token that went somewhere else is failed', async () => {
    const { app, proofId } = await submitted();
    chainReads = {
      transaction: {
        receipt: { status: 'success', transactionHash: TX, blockNumber: 30_000_000n, gasUsed: 210_000n, logs: [transferLog(OTHER_WALLET)] },
        actualNativeValueWei: PRICE,
      },
      owner: { owner: OTHER_WALLET, blockNumber: '30000001' },
    };
    const response = await request(app).post(`/api/route-intelligence/nft/proofs/${proofId}/reconcile`).send({});
    assert.equal(response.body.proof.finalStatus, 'failed');
  });

  test('a revert is terminal', async () => {
    const { app, proofId } = await submitted();
    chainReads = {
      transaction: {
        receipt: { status: 'reverted', transactionHash: TX, blockNumber: 30_000_000n, gasUsed: 90_000n, logs: [] },
        actualNativeValueWei: PRICE,
      },
      owner: null,
    };
    const response = await request(app).post(`/api/route-intelligence/nft/proofs/${proofId}/reconcile`).send({});
    assert.equal(response.body.proof.finalStatus, 'transaction_failed');
    assert.match(response.body.copy, /was not bought/);
  });

  test('reconciling twice does not double the event log', async () => {
    const { app, proofId } = await submitted();
    chainReads = {
      transaction: {
        receipt: { status: 'success', transactionHash: TX, blockNumber: 30_000_000n, gasUsed: 210_000n, logs: [transferLog(WALLET)] },
        actualNativeValueWei: PRICE,
      },
      owner: { owner: WALLET, blockNumber: '30000001' },
    };
    await request(app).post(`/api/route-intelligence/nft/proofs/${proofId}/reconcile`).send({});
    const events = await repository.listNftProofEvents(proofId, USER.id);
    await request(app).post(`/api/route-intelligence/nft/proofs/${proofId}/reconcile`).send({});
    const after = await repository.listNftProofEvents(proofId, USER.id);
    assert.equal(after.length, events.length);
  });

  test("another tenant cannot read or reconcile someone else's proof", async () => {
    const { proofId } = await submitted();
    const other = routeApp(OTHER_USER);
    assert.equal((await request(other).get(`/api/route-intelligence/nft/proofs/${proofId}`)).status, 404);
    assert.equal((await request(other).post(`/api/route-intelligence/nft/proofs/${proofId}/reconcile`).send({})).status, 404);
  });
});
