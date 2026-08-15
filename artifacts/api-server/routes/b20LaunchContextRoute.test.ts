import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe } from 'node:test';
import express from 'express';
import request from 'supertest';

import { b20ControlRouter, b20RouteRuntime } from './b20Control.js';

// ---------------------------------------------------------------------------
// Launch Context over HTTP.
//
// One property matters more than the rest and every test here circles it: the
// response must be unable to carry a count that the domain layer refused to
// make. Measured on the first 300 stored launches, every repeated sender was a
// bundler or a relayer — so a `corpus` beside a relayed launch would put
// unrelated projects under one address and print counts about them.
// ---------------------------------------------------------------------------

const WALLET = '0x1111111111111111111111111111111111111111';
const TOKEN = '0xb200000000000000000000195a5f43905160ee01';
const LAUNCH_ID = `0x${'1'.repeat(64)}:0`;
const FACTORY = '0xb20f000000000000000000000000000000000000';
const ENTRYPOINT = '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789';
const SENDER = '0x07431d0db9042f8be2368bbff98d2879b4e665ab';

const row = {
  launch: {
    id: LAUNCH_ID,
    tokenAddress: TOKEN,
    name: 'AVANTIS',
    symbol: 'AVA',
    variant: 'asset',
    decimals: 18,
    blockNumber: '49929300',
    transactionHash: `0x${'1'.repeat(64)}`,
    logIndex: 0,
    detectedAt: '2026-08-13T18:00:00.000Z',
    blockTimestamp: '2026-08-13T17:59:00.000Z',
    canonical: true,
  },
  observation: null,
  launchBuyers: null,
};

function observationsRepo() {
  return {
    getFeedRowForToken: async ({ tokenAddress }: { tokenAddress: string }) =>
      tokenAddress === TOKEN ? { row, history: [] } : null,
  } as never;
}

function deployersRepo(stored: Record<string, unknown> | null) {
  return {
    readDeployer: async () => stored,
    countsForDeployer: async () => ({
      launchCount: 8,
      launches: [
        { launchId: LAUNCH_ID, tokenAddress: TOKEN, symbol: 'AVA', state: 'rejected', reasonCode: 'no_exit_route', exitRouteFound: false },
      ],
    }),
    deployerCoverage: async () => ({ launchesRead: 300, launchesTotal: 5909 }),
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
  b20RouteRuntime.observations = observationsRepo;
  b20RouteRuntime.now = () => new Date('2026-08-16T00:00:00.000Z');
});

afterEach(() => {
  Object.assign(b20RouteRuntime, original);
});

const get = (token = TOKEN, authenticated = true) =>
  request(app(authenticated)).get(`/api/route-intelligence/opportunities/b20/${token}/context`);

const deployerRow = (transactionTo: string | null) => ({
  launchId: LAUNCH_ID,
  chainId: 8453,
  deployerAddress: SENDER,
  transactionTo,
  transactionBlockNumber: '49929300',
  readAt: '2026-08-16T00:00:00.000Z',
  source: 'base-rpc/v1',
});

describe('the sender is only an anchor when nothing stood in between', () => {
  test('a direct launch carries its counts', async () => {
    b20RouteRuntime.deployers = () => deployersRepo(deployerRow(FACTORY));
    const response = await get();
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.reading.relation, 'direct');
    assert.equal(response.body.corpus.launchCount, 8);
    assert.deepEqual(response.body.corpus.coverage, { launchesRead: 300, launchesTotal: 5909 });
  });

  test('a bundler-relayed launch carries NO counts at all', async () => {
    // The one that would have been wrong. `tx.from` here is whoever paid to
    // include somebody else's UserOperation.
    b20RouteRuntime.deployers = () => deployersRepo(deployerRow(ENTRYPOINT));
    const response = await get();
    assert.equal(response.body.reading.relation, 'bundler');
    assert.equal(response.body.corpus, null);
    assert.ok(
      response.body.caveats.some((caveat: string) => /would group unrelated projects/.test(caveat)),
      JSON.stringify(response.body.caveats),
    );
  });

  test('an intermediary is refused the same way', async () => {
    b20RouteRuntime.deployers = () => deployersRepo(deployerRow('0xa52ad458ce0282a971ecc71c051a32f28946bb9f'));
    const response = await get();
    assert.equal(response.body.reading.relation, 'intermediary');
    assert.equal(response.body.corpus, null);
  });

  test('an unread launch is not a launch without a sender', async () => {
    b20RouteRuntime.deployers = () => deployersRepo(null);
    const response = await get();
    assert.equal(response.body.reading.status, 'not_read');
    assert.equal(response.body.corpus, null);
    assert.match(response.body.headline, /has not read this launch’s transaction/);
  });
});

describe('the response says what it is not', () => {
  test('identity defaults to unverified, with the checklist and no score', async () => {
    b20RouteRuntime.deployers = () => deployersRepo(deployerRow(FACTORY));
    const response = await get();
    assert.equal(response.body.claim.status, 'no_claim');
    assert.equal(response.body.claim.headline, 'Unverified context.');
    assert.equal(response.body.claim.verifiedLabel, '0 of 3');
    assert.equal(JSON.stringify(response.body).toLowerCase().includes('"score"'), false);
  });

  test('an address is never presented as a person', async () => {
    b20RouteRuntime.deployers = () => deployersRepo(deployerRow(FACTORY));
    const response = await get();
    assert.ok(
      response.body.caveats.some((caveat: string) => /not a team, a company or a reputation/.test(caveat)),
    );
  });
});

describe('refusals', () => {
  test('a malformed address is a 400, an unknown token a 404', async () => {
    b20RouteRuntime.deployers = () => deployersRepo(null);
    assert.equal((await get('0xdeadbeef')).status, 400);
    assert.equal((await get(`0x${'9'.repeat(40)}`)).status, 404);
  });

  test('an anonymous request is refused', async () => {
    b20RouteRuntime.deployers = () => deployersRepo(null);
    assert.equal((await get(TOKEN, false)).status, 401);
  });

  test('discover being off is a 503, not an empty context', async () => {
    b20RouteRuntime.deployers = () => deployersRepo(null);
    b20RouteRuntime.discoverAvailable = async () => false;
    assert.equal((await get()).status, 503);
  });
});
