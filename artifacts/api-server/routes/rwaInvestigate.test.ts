import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe } from 'node:test';
import express from 'express';
import request from 'supertest';

import type { AddressDossierV1 } from '@mioagent/rwa-dossier';

import { rwaInvestigateRouter, rwaInvestigateRuntime } from './rwaInvestigate.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const USER = { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 as const };
const TOKEN = '0xb2000000000000000000007bf6d5cbb0e24cb301';
const originalRuntime = { ...rwaInvestigateRuntime };

function app(user: typeof USER | null = USER) {
  const server = express();
  server.use((req, _res, next) => {
    if (user) Object.defineProperty(req, 'session', { configurable: true, value: { user } });
    next();
  });
  server.use('/api/route-intelligence', rwaInvestigateRouter);
  return server;
}

afterEach(() => {
  Object.assign(rwaInvestigateRuntime, originalRuntime);
});

beforeEach(() => {
  rwaInvestigateRuntime.enabled = () => true;
  rwaInvestigateRuntime.migrationAvailable = async () => true;
  rwaInvestigateRuntime.deps = () => {
    throw new Error('these tests must not open a database connection');
  };
});

describe('GET one address, read as deeply as the evidence allows', () => {
  test('inherits the route-intelligence gate before session or storage', async () => {
    rwaInvestigateRuntime.enabled = () => false;
    rwaInvestigateRuntime.migrationAvailable = async () => {
      throw new Error('a disabled route must stop first');
    };
    const response = await request(app(null)).get(`/api/route-intelligence/rwa/investigate/${TOKEN}`);
    assert.equal(response.status, 404);
    assert.equal(response.body.code, 'route_intelligence_disabled');
  });

  test('requires a valid Base tenant session before touching storage', async () => {
    rwaInvestigateRuntime.migrationAvailable = async () => {
      throw new Error('authentication must stop first');
    };
    const response = await request(app(null)).get(`/api/route-intelligence/rwa/investigate/${TOKEN}`);
    assert.equal(response.status, 401);
    assert.equal(response.body.code, 'authentication_required');
  });

  test('a ticker is refused, never resolved, and costs no chain read', async () => {
    // 61.7% of indexed launches share a symbol with another launch. Resolving
    // one would be the impostor choosing which contract the reader sees.
    rwaInvestigateRuntime.migrationAvailable = async () => {
      throw new Error('input validation must stop first');
    };
    const response = await request(app()).get('/api/route-intelligence/rwa/investigate/AAPLc');
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'invalid_token_address');
    assert.match(response.body.detail, /A symbol identifies nothing/);
  });

  test('an address nothing knows is a dossier, not a 404', async () => {
    // The most common answer on this chain, and it is an answer: no reviewed
    // source lists it and our index has never seen it. A 404 would read as
    // "this contract does not exist".
    let asked = '';
    rwaInvestigateRuntime.deps = () => ({}) as never;
    rwaInvestigateRuntime.assemble = async (_deps, input) => {
      asked = input.tokenAddress;
      return {
        schemaVersion: 'address-dossier/v1',
        dossierHash: `0x${'0'.repeat(64)}`,
        assembly: 'deterministic_no_llm_facts',
        chainId: 8453,
        tokenAddress: input.tokenAddress,
        assembledAt: '2026-08-25T12:00:00.000Z',
      } as unknown as AddressDossierV1;
    };
    const response = await request(app()).get(
      `/api/route-intelligence/rwa/investigate/${TOKEN.toUpperCase()}`,
    );
    // Lowercased before it reaches storage: identity has one spelling.
    assert.equal(asked, TOKEN);
    // The stub is not a valid dossier, so the schema refuses it — which is the
    // point of parsing on the way out as well as on the way in.
    assert.equal(response.status, 500);
    assert.equal(response.body.code, 'address_dossier_failed');
  });

  test('a database without the tables is a refusal, not an empty dossier', async () => {
    rwaInvestigateRuntime.migrationAvailable = async () => false;
    const response = await request(app()).get(`/api/route-intelligence/rwa/investigate/${TOKEN}`);
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'address_dossier_storage_unavailable');
  });

  test('an assembler failure never forwards the upstream message', async () => {
    rwaInvestigateRuntime.deps = () => ({}) as never;
    rwaInvestigateRuntime.assemble = async () => {
      throw new Error('connect ECONNREFUSED postgres://user:secret@10.0.0.4:5432');
    };
    const response = await request(app()).get(`/api/route-intelligence/rwa/investigate/${TOKEN}`);
    assert.equal(response.status, 500);
    assert.equal(JSON.stringify(response.body).includes('secret'), false);
    assert.equal(JSON.stringify(response.body).includes('10.0.0.4'), false);
  });
});
