import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe } from 'node:test';
import express from 'express';
import request from 'supertest';

import { verifyHandoffTokenV1 } from '../lib/mcpHandoffToken.js';
import { mcpHandoffRouter, mcpHandoffRuntime } from './mcpHandoff.js';

// ---------------------------------------------------------------------------
// T72-B §1 — a handoff token can only come from a session that already proved
// the wallet.
//
// The route is mounted here on its own, behind a fake session, because what is
// being tested is the binding rather than the middleware stack: whatever the
// session says the wallet is, that is what the token says, and there is no
// request shape that changes it.
// ---------------------------------------------------------------------------

const WALLET = '0x1111111111111111111111111111111111111111';
const TENANT = `eip155:8453:${WALLET}`;
const NOW = new Date('2026-08-06T12:00:00.000Z');

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
  b20ControlV1: true,
  submissionRecoveryV1: false,
  publicProofV1: false,
  mcpPrivateV1: true,
  mcpPrivateExecutionV1: true,
  routeOutcomeFeedbackV1: false,
} as const;

function app(user: unknown = { id: TENANT, address: WALLET, chainId: 8453 }) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = user ? { user } : {};
    next();
  });
  server.use('/handoff', mcpHandoffRouter);
  return server;
}

const originalFlags = mcpHandoffRuntime.flags;
const originalNow = mcpHandoffRuntime.now;
let originalSecret: string | undefined;

beforeEach(() => {
  originalSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'session-secret-under-test';
  mcpHandoffRuntime.flags = () => ({ ...FLAGS });
  mcpHandoffRuntime.now = () => NOW;
});

afterEach(() => {
  mcpHandoffRuntime.flags = originalFlags;
  mcpHandoffRuntime.now = originalNow;
  if (originalSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = originalSecret;
});

describe('§1 — minting a handoff token', () => {
  test('a signed-in wallet receives a token bound to itself', async () => {
    const response = await request(app()).post('/handoff').send({});
    assert.equal(response.status, 200);
    assert.equal(response.body.walletAddress, WALLET);
    const verified = verifyHandoffTokenV1({
      token: response.body.token,
      secret: process.env.SESSION_SECRET!,
      now: NOW,
    });
    assert.equal(verified.ok, true);
    assert.equal(verified.ok && verified.claims.tenantId, TENANT);
  });

  test('a wallet named in the body is ignored, not honoured', async () => {
    // There is no request shape that mints a token for somebody else.
    const response = await request(app())
      .post('/handoff')
      .send({ walletAddress: '0x2222222222222222222222222222222222222222', userId: 'someone-else' });
    assert.equal(response.status, 200);
    assert.equal(response.body.walletAddress, WALLET);
  });

  test('an unauthenticated caller gets nothing', async () => {
    const response = await request(app(null)).post('/handoff').send({});
    assert.equal(response.status, 401);
    assert.equal(response.body.token, undefined);
  });

  test('a dev single-user session cannot mint', async () => {
    const response = await request(app({ id: 'default-user', address: WALLET, chainId: 8453 }))
      .post('/handoff')
      .send({});
    assert.equal(response.status, 401);
  });

  test('the route is invisible while the flag is off', async () => {
    mcpHandoffRuntime.flags = () => ({ ...FLAGS, mcpPrivateV1: false });
    assert.equal((await request(app()).post('/handoff').send({})).status, 404);
  });

  test('no signing secret is a refusal, never a default key', async () => {
    delete process.env.SESSION_SECRET;
    const response = await request(app()).post('/handoff').send({});
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'mcp_handoff_unavailable');
  });

  test('the response says the one thing a holder cannot infer', async () => {
    const response = await request(app()).post('/handoff').send({});
    assert.match(response.body.notice, /cannot be revoked before then/i);
    assert.match(response.body.notice, /approved in your Base Account/i);
  });

  test('the status read never returns a token', async () => {
    const response = await request(app()).get('/handoff');
    assert.equal(response.status, 200);
    assert.equal(response.body.available, true);
    assert.equal(response.body.token, undefined);
    assert.equal(response.body.endpointPath, '/mcp/private');
  });
});
