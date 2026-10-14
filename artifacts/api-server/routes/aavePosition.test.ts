import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import request from 'supertest';
import { AAVE_V4_BASE_SPOKE_V1, type AaveV4PositionV1 } from '@mioagent/rwa-issuer/aaveV4';
import { aavePositionRuntimeV1, aavePositionRouter } from './aavePosition.js';

const WALLET = '0x1111111111111111111111111111111111111111';
function app(wallet: string | null) {
  const server = express();
  server.use((req, _res, next) => {
    Object.assign(req, { session: { user: wallet ? { id: `eip155:8453:${wallet}`, address: wallet, chainId: 8453 } : null } });
    next();
  });
  server.use('/aave', aavePositionRouter); return server;
}
const empty: AaveV4PositionV1 = {
  schemaVersion: 'aave-v4-position/v1' as const, chainId: 8453 as const, walletAddress: WALLET,
  spokeAddress: AAVE_V4_BASE_SPOKE_V1, observedAt: '2026-10-14T12:00:00Z', source: 'aave_api' as const,
  state: 'empty' as const, collateralUsd: null, debtUsd: null, netAccruedInterestUsd: null,
  netBorrowApyBps: null, healthFactor: null, remainingBorrowingPowerUsd: null,
};
test('Aave position is session-only, rejects account overrides, and validates the returned wallet', async () => {
  const original = aavePositionRuntimeV1.read;
  const wallets: string[] = [];
  try {
    aavePositionRuntimeV1.read = async wallet => { wallets.push(wallet); return empty; };
    assert.equal((await request(app(null)).get('/aave/position')).status, 401);
    assert.equal((await request(app('0x'+'0'.repeat(40))).get('/aave/position')).status, 401);
    assert.equal((await request(app(WALLET)).get('/aave/position?user='+WALLET)).status, 400);
    assert.deepEqual(wallets, []);
    const response = await request(app(WALLET)).get('/aave/position');
    assert.equal(response.status, 200); assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.deepEqual(wallets, [WALLET]); assert.equal(response.body.state, 'empty');
    aavePositionRuntimeV1.read = async () => ({ ...empty, walletAddress: '0x'+'2'.repeat(40) });
    assert.equal((await request(app(WALLET)).get('/aave/position')).status, 503);
    aavePositionRuntimeV1.read = async () => { throw new Error('https://private.example/key'); };
    const failed = await request(app(WALLET)).get('/aave/position');
    assert.equal(failed.status, 503); assert.deepEqual(failed.body, { code: 'aave_v4_position_unread' });
  } finally { aavePositionRuntimeV1.read = original; }
});
