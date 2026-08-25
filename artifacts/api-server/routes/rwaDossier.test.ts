import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe } from 'node:test';
import express from 'express';
import request from 'supertest';

import { rwaDossierRouter, rwaDossierRuntime } from './rwaDossier.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const USER = { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 as const };
const TOKEN = '0xb2000000000000000000007bf6d5cbb0e24cb301';
const originalRuntime = { ...rwaDossierRuntime };

function app(user: typeof USER | null = USER) {
  const server = express();
  server.use((req, _res, next) => {
    if (user) Object.defineProperty(req, 'session', { configurable: true, value: { user } });
    next();
  });
  server.use('/api/route-intelligence', rwaDossierRouter);
  return server;
}

afterEach(() => {
  Object.assign(rwaDossierRuntime, originalRuntime);
});

beforeEach(() => {
  rwaDossierRuntime.enabled = () => true;
});

describe('GET official asset dossier', () => {
  test('inherits the route-intelligence feature gate before session or storage', async () => {
    rwaDossierRuntime.enabled = () => false;
    rwaDossierRuntime.migrationAvailable = async () => {
      throw new Error('disabled routes must stop first');
    };
    const response = await request(app(null)).get(`/api/route-intelligence/rwa/official/${TOKEN}/dossier`);
    assert.equal(response.status, 404);
    assert.equal(response.body.code, 'route_intelligence_disabled');
  });

  test('requires a valid Base tenant session before touching storage', async () => {
    rwaDossierRuntime.migrationAvailable = async () => {
      throw new Error('authentication must stop first');
    };
    const response = await request(app(null)).get(`/api/route-intelligence/rwa/official/${TOKEN}/dossier`);
    assert.equal(response.status, 401);
    assert.equal(response.body.code, 'authentication_required');
  });

  test('requires an exact address, never a ticker', async () => {
    rwaDossierRuntime.migrationAvailable = async () => {
      throw new Error('input validation must stop first');
    };
    const response = await request(app()).get('/api/route-intelligence/rwa/official/ACMEon/dossier');
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'invalid_official_asset_address');
  });

  test('returns a typed not-in-corpus outcome as evidence, not a transport failure', async () => {
    let supplied = '';
    rwaDossierRuntime.migrationAvailable = async () => true;
    rwaDossierRuntime.assemble = async (_deps, input) => {
      supplied = input.tokenAddress;
      return {
        outcome: 'not_in_reviewed_corpus',
        chainId: 8453,
        tokenAddress: input.tokenAddress,
        detail: 'No currently listed reviewed source snapshot establishes this exact address as official.',
      };
    };
    const response = await request(app()).get(
      `/api/route-intelligence/rwa/official/${TOKEN.toUpperCase()}/dossier`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'not_in_reviewed_corpus');
    assert.equal(response.body.tokenAddress, TOKEN);
    assert.equal(supplied, TOKEN);
  });

  test('fails closed when the evidence schema is not installed', async () => {
    rwaDossierRuntime.migrationAvailable = async () => false;
    const response = await request(app()).get(`/api/route-intelligence/rwa/official/${TOKEN}/dossier`);
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'official_asset_dossier_storage_unavailable');
  });

  test('does not echo provider or database error details', async () => {
    rwaDossierRuntime.migrationAvailable = async () => {
      throw new Error('postgresql://user:secret@host/db');
    };
    const response = await request(app()).get(`/api/route-intelligence/rwa/official/${TOKEN}/dossier`);
    assert.equal(response.status, 500);
    assert.equal(response.body.code, 'official_asset_dossier_failed');
    assert.ok(!JSON.stringify(response.body).includes('secret'));
  });
});
