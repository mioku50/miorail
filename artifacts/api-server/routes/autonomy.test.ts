import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { app } from '../app.js';

describe('Autonomy API Hardening Guarantees', () => {
  beforeEach(async () => {
    await request(app).post('/api/autonomy/reset').send({});
  });

  test('GET /api/autonomy returns honest missing source and unconfigured state without fake defaults', async () => {
    const res = await request(app).get('/api/autonomy');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'unconfigured');
    assert.strictEqual(res.body.source, 'missing');
    assert.strictEqual(res.body.sessionKey.status, 'unconfigured');
    assert.strictEqual(res.body.sessionKey.source, 'missing');
    assert.strictEqual(res.body.sessionKey.dailyLimitUsdc, null);
    assert.strictEqual(res.body.sessionKey.maxPerActionUsdc, null);
    assert.deepStrictEqual(res.body.sessionKey.whitelist, []);
    assert.strictEqual(res.body.autonomy.dailySpendLimit, null);
    assert.strictEqual(res.body.autonomy.maxActionSpend, null);
    assert.strictEqual(res.body.autonomy.whitelistedProtocolsCount, 0);
  });

  test('POST /api/autonomy/config rejects request if explicit limits or whitelist are missing', async () => {
    // Missing whitelist and ttlSeconds
    const res1 = await request(app).post('/api/autonomy/config').send({
      dailyLimitUsdc: '50',
      maxPerActionUsdc: '5',
    });
    assert.strictEqual(res1.status, 400);

    // Missing dailyLimitUsdc
    const res2 = await request(app).post('/api/autonomy/config').send({
      maxPerActionUsdc: '5',
      whitelist: ['0x036cbd53842c5426634e7929541ec2318f3dcf7e'],
      ttlSeconds: 3600,
    });
    assert.strictEqual(res2.status, 400);
  });

  test('POST /api/autonomy/config configures session key in memory with explicit values only', async () => {
    const payload = {
      dailyLimitUsdc: '250.50',
      maxPerActionUsdc: '25.00',
      whitelist: ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222'],
      scope: 'Custom Yield Scope',
      ttlSeconds: 43200,
    };

    const res = await request(app).post('/api/autonomy/config').send(payload);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.state.status, 'active');
    assert.strictEqual(res.body.state.source, 'memory');
    assert.strictEqual(res.body.state.sessionKey.status, 'configured');
    assert.strictEqual(res.body.state.sessionKey.source, 'memory');
    assert.strictEqual(res.body.state.sessionKey.dailyLimitUsdc, '250.50');
    assert.strictEqual(res.body.state.sessionKey.maxPerActionUsdc, '25.00');
    assert.deepStrictEqual(res.body.state.sessionKey.whitelist, payload.whitelist);
    assert.strictEqual(res.body.state.sessionKey.scope, 'Custom Yield Scope');
    assert.strictEqual(res.body.state.sessionKey.ttlSeconds, 43200);
  });

  test('POST /api/autonomy/testnet/configure rejects with 403 when ENABLE_TESTNET_AUTONOMY is not true', async () => {
    delete process.env.ENABLE_TESTNET_AUTONOMY;
    const res = await request(app).post('/api/autonomy/testnet/configure').send({
      dailyLimitUsdc: '100',
      maxPerActionUsdc: '20',
      whitelist: ['0x1111111111111111111111111111111111111111'],
      ttlSeconds: 3600,
    });
    assert.strictEqual(res.status, 403);
  });

  test('POST /api/autonomy/testnet/configure succeeds when ENABLE_TESTNET_AUTONOMY=true', async () => {
    process.env.ENABLE_TESTNET_AUTONOMY = 'true';
    const payload = {
      dailyLimitUsdc: '100',
      maxPerActionUsdc: '20',
      whitelist: ['0x1111111111111111111111111111111111111111'],
      ttlSeconds: 3600,
      txHash: '0xabc1234567890123456789012345678901234567890123456789012345678901',
    };

    const res = await request(app).post('/api/autonomy/testnet/configure').send(payload);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.txHash, payload.txHash);
    assert.strictEqual(res.body.state.autonomy.mode, 'base-sepolia');
    assert.strictEqual(res.body.state.sessionKey.dailyLimitUsdc, '100');

    // Test revoke
    const revokeRes = await request(app).post('/api/autonomy/testnet/revoke').send({
      txHash: '0xdef1234567890123456789012345678901234567890123456789012345678901',
    });
    assert.strictEqual(revokeRes.status, 200);
    assert.strictEqual(revokeRes.body.state.status, 'revoked');
    assert.strictEqual(revokeRes.body.state.sessionKey.killSwitch, true);

    delete process.env.ENABLE_TESTNET_AUTONOMY;
  });

  test('GET /api/autonomy returns unconfigured and isStaleTestMemory=true when memory contains dummy T16 test identities', async () => {
    await request(app).post('/api/autonomy/config').send({
      dailyLimitUsdc: '100',
      maxPerActionUsdc: '20',
      whitelist: ['0x036cbd53842c5426634e7929541ec2318f3dcf7e'],
      ttlSeconds: 3600,
    });
    const res = await request(app).get('/api/autonomy?owner=0x1111111111111111111111111111111111111111');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'unconfigured');
    assert.strictEqual(res.body.sessionKey.status, 'unconfigured');
    assert.strictEqual(res.body.isStaleTestMemory, true);
  });

  test('GET /api/autonomy returns status=expired and null limits when memory config is expired', async () => {
    await request(app).post('/api/autonomy/config').send({
      dailyLimitUsdc: '100',
      maxPerActionUsdc: '20',
      whitelist: ['0x036cbd53842c5426634e7929541ec2318f3dcf7e'],
      ttlSeconds: -10, // expired in the past
    });
    const res = await request(app).get('/api/autonomy?owner=0x8888888888888888888888888888888888888888');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'expired');
    assert.strictEqual(res.body.sessionKey.status, 'expired');
    assert.strictEqual(res.body.isExpiredMemory, true);
    assert.strictEqual(res.body.sessionKey.dailyLimitUsdc, null);
    assert.strictEqual(res.body.sessionKey.maxPerActionUsdc, null);
    assert.strictEqual(res.body.autonomy.dailySpendLimit, null);
    assert.strictEqual(res.body.autonomy.maxActionSpend, null);
  });
});
