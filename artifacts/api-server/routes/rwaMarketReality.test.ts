import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe } from 'node:test';
import express from 'express';
import request from 'supertest';

import { rwaMarketRealityRouter, rwaMarketRealityRuntime } from './rwaMarketReality.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const USER = { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 as const };
const UNDERLYING = 'security:isin:US67066G1040';
const originalRuntime = { ...rwaMarketRealityRuntime };

function app(user: typeof USER | null = USER) {
  const server = express();
  server.use((req, _res, next) => {
    if (user) Object.defineProperty(req, 'session', { configurable: true, value: { user } });
    next();
  });
  server.use('/api/route-intelligence', rwaMarketRealityRouter);
  return server;
}

afterEach(() => {
  Object.assign(rwaMarketRealityRuntime, originalRuntime);
});

beforeEach(() => {
  rwaMarketRealityRuntime.enabled = () => true;
});

describe('GET multi-issuer Market Reality', () => {
  test('requires a valid Base tenant session before storage', async () => {
    rwaMarketRealityRuntime.migrationAvailable = async () => {
      throw new Error('authentication must stop first');
    };
    const response = await request(app(null)).get(
      `/api/route-intelligence/rwa/market-reality/${UNDERLYING}?direction=buy&requestedCashAtomic=100000000`,
    );
    assert.equal(response.status, 401);
    assert.equal(response.body.code, 'authentication_required');
  });

  test('requires one exact positive size and direction', async () => {
    rwaMarketRealityRuntime.migrationAvailable = async () => {
      throw new Error('input validation must stop first');
    };
    const response = await request(app()).get(
      `/api/route-intelligence/rwa/market-reality/${UNDERLYING}?direction=buy&requestedCashAtomic=100.5`,
    );
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'invalid_market_reality_question');
  });

  test('passes the exact question and keeps ranking withheld without comparable coverage', async () => {
    let supplied: unknown = null;
    rwaMarketRealityRuntime.migrationAvailable = async () => true;
    rwaMarketRealityRuntime.assemble = async (_deps, input) => {
      supplied = input;
      return {
        schemaVersion: 'market-reality/v1',
        question: {
          chainId: 8453,
          underlyingKey: input.underlyingKey,
          direction: input.direction,
          requestedCashAtomic: input.requestedCashAtomic,
          cashAsset: 'USDC',
          cashAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
          cashDecimals: 6,
          destination: input.destination ?? 'USDC',
          exactSizeOnly: true,
          baseOnly: true,
        },
        coverage: {
          policy: 'same_approved_router_set_exact_size_and_destination',
          reviewedRepresentations: 0,
          comparableRepresentations: 0,
          status: 'incomplete',
          reason: 'No reviewed representation is bound to this exact underlying.',
        },
        ranking: {
          status: 'withheld',
          orderedTokenAddresses: [],
          reason: 'Coverage comparability did not pass; no BEST representation is emitted.',
        },
        quoteEvidenceIsExecutionProof: false,
        representations: [],
        assembledAt: '2026-08-26T18:00:00.000Z',
      };
    };
    const response = await request(app()).get(
      `/api/route-intelligence/rwa/market-reality/${UNDERLYING}?direction=sell&requestedCashAtomic=100000000&destination=USDC`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.ranking.status, 'withheld');
    assert.deepEqual(supplied, {
      underlyingKey: UNDERLYING,
      direction: 'sell',
      requestedCashAtomic: '100000000',
      destination: 'USDC',
    });
  });
});
