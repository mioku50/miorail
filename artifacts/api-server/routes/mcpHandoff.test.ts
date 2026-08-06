import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe } from 'node:test';
import express from 'express';
import request from 'supertest';

import {
  InMemoryMcpExecutionAuditRepositoryV1,
  InMemoryMcpHandoffRevocationRepositoryV1,
} from '@mioagent/route-storage';

import { MCP_HANDOFF_DEFAULT_TTL_MS_V1, verifyHandoffTokenV1 } from '../lib/mcpHandoffToken.js';
import { mcpAuditRuntime } from './mcpPrivate/audit.js';
import { mcpHandoffRouter, mcpHandoffRuntime, mcpPrivateStatusLinesV1 } from './mcpHandoff.js';

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
const originalAudit = { ...mcpAuditRuntime };
let originalSecret: string | undefined;
let audit: InMemoryMcpExecutionAuditRepositoryV1;
let revocations: InMemoryMcpHandoffRevocationRepositoryV1;

beforeEach(() => {
  originalSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'session-secret-under-test';
  mcpHandoffRuntime.flags = () => ({ ...FLAGS });
  mcpHandoffRuntime.now = () => NOW;
  audit = new InMemoryMcpExecutionAuditRepositoryV1();
  revocations = new InMemoryMcpHandoffRevocationRepositoryV1();
  mcpAuditRuntime.available = async () => true;
  mcpAuditRuntime.audit = () => audit;
  mcpAuditRuntime.revocations = () => revocations;
  mcpAuditRuntime.now = () => NOW;
});

afterEach(() => {
  mcpHandoffRuntime.flags = originalFlags;
  mcpHandoffRuntime.now = originalNow;
  Object.assign(mcpAuditRuntime, originalAudit);
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
    assert.match(response.body.notice, /approved in your Base Account/i);
    assert.match(response.body.notice, /revoke it by its token id/i);
    assert.equal(response.body.revokePath, '/api/mcp/handoff/revoke');
  });

  test('the status read never returns a token', async () => {
    const response = await request(app()).get('/handoff');
    assert.equal(response.status, 200);
    assert.equal(response.body.available, true);
    assert.equal(response.body.token, undefined);
    assert.equal(response.body.endpointPath, '/mcp/private');
  });

  test('T72-C §3 — production tokens live fifteen minutes', async () => {
    delete process.env.MIORAIL_MCP_HANDOFF_TTL_MS;
    assert.equal(MCP_HANDOFF_DEFAULT_TTL_MS_V1, 15 * 60 * 1000);
    const response = await request(app()).post('/handoff').send({});
    assert.equal(response.body.expiresInMs, 15 * 60 * 1000);
  });

  test('T72-C §1 — issuance is audited by token id, never by token', async () => {
    const response = await request(app()).post('/handoff').send({});
    const rows = await audit.listForTenant({ tenantId: TENANT });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'token_issued');
    assert.equal(rows[0].tokenId, response.body.tokenId);
    assert.ok(!JSON.stringify(rows).includes(response.body.token), 'the token reached the audit');
  });

  test('T72-C §2 — a missing audit does not stop a user minting a token', async () => {
    // Nothing irreversible happens at issuance, and locking a user out of their
    // own product because a log table is missing would be the worse failure.
    mcpAuditRuntime.available = async () => false;
    assert.equal((await request(app()).post('/handoff').send({})).status, 200);
  });
});

describe('T72-C §3 — revoking a token', () => {
  test('revoking by id records a revocation for this tenant', async () => {
    const minted = await request(app()).post('/handoff').send({});
    const response = await request(app()).post('/handoff/revoke').send({ tokenId: minted.body.tokenId });
    assert.equal(response.status, 200);
    assert.equal(response.body.revoked, true);
    assert.equal(await revocations.isRevoked({ tokenId: minted.body.tokenId, tenantId: TENANT }), true);
  });

  test('revoking twice is not an error', async () => {
    const minted = await request(app()).post('/handoff').send({});
    await request(app()).post('/handoff/revoke').send({ tokenId: minted.body.tokenId });
    assert.equal(
      (await request(app()).post('/handoff/revoke').send({ tokenId: minted.body.tokenId })).status,
      200,
    );
  });

  test('the token itself is refused, so it is never stored', async () => {
    // An endpoint that accepted the credential is one a user could be tricked
    // into pasting it into — and it would put the token in a body, a log and an
    // error report on the way.
    const minted = await request(app()).post('/handoff').send({});
    const response = await request(app()).post('/handoff/revoke').send({ tokenId: minted.body.token });
    assert.equal(response.status, 400);
    assert.match(response.body.detail, /token id/i);
    assert.equal((await revocations.listForTenant(TENANT)).length, 0);
  });

  test('a browser session cannot be revoked out from under everyone', async () => {
    assert.equal((await request(app()).post('/handoff/revoke').send({ tokenId: 'session' })).status, 400);
  });

  test('revocation fails closed when it cannot be persisted', async () => {
    // Unlike the read-path lookup, which fails open: a revocation that silently
    // did not persist is worse than one that reports it could not.
    mcpAuditRuntime.available = async () => false;
    const response = await request(app()).post('/handoff/revoke').send({ tokenId: 'token-1' });
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'mcp_revocation_unavailable');
  });

  test('an unauthenticated caller cannot revoke', async () => {
    assert.equal((await request(app(null)).post('/handoff/revoke').send({ tokenId: 'x' })).status, 401);
  });
});

describe('T72-C §8 — the deployment summary reports state, not intent', () => {
  test('the summary lines are exactly the operator-facing block', async () => {
    const response = await request(app()).get('/handoff');
    assert.deepEqual(response.body.summary, [
      'Private MCP surface: enabled',
      'Executable handoff: enabled',
      'Token TTL: 15 minutes',
      'Audit storage: available',
      'Public MCP: read-only',
      'Live smoke: disabled',
    ]);
  });

  test('audit availability is looked up, not read off a variable', async () => {
    // An operator who trusts this line has to be able to trust that something
    // actually went and looked.
    mcpAuditRuntime.available = async () => false;
    const response = await request(app()).get('/handoff');
    assert.equal(response.body.auditStorageAvailable, false);
    assert.ok(response.body.summary.includes('Audit storage: unavailable'));
  });

  test('one producer, so the JSON and the printed block cannot disagree', async () => {
    const response = await request(app()).get('/handoff');
    assert.deepEqual(mcpPrivateStatusLinesV1(response.body), response.body.summary);
  });
});
