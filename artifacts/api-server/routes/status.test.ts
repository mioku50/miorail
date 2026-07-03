import test, { describe } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { app } from '../app.js';
import { clearTokenSecurityCacheForTests } from '@mioagent/data-providers';

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe('Status API', () => {
  test('GET /api/status returns missing risk provider by default', async () => {
    const original = process.env.TOKEN_SECURITY_PROVIDER;
    const originalApiKey = process.env.GOPLUS_API_KEY;
    delete process.env.TOKEN_SECURITY_PROVIDER;
    delete process.env.GOPLUS_API_KEY;

    const response = await request(app).get('/api/status');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.risk.provider, 'none');
    assert.strictEqual(response.body.risk.status, 'missing');

    restoreEnv('TOKEN_SECURITY_PROVIDER', original);
    restoreEnv('GOPLUS_API_KEY', originalApiKey);
  });

  test('GET /api/status returns GoPlus connected without requiring API key', async () => {
    clearTokenSecurityCacheForTests();
    const original = process.env.TOKEN_SECURITY_PROVIDER;
    const originalApiKey = process.env.GOPLUS_API_KEY;
    process.env.TOKEN_SECURITY_PROVIDER = 'goplus';
    delete process.env.GOPLUS_API_KEY;

    const response = await request(app).get('/api/status');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.risk.provider, 'goplus');
    assert.strictEqual(response.body.risk.status, 'connected');

    restoreEnv('TOKEN_SECURITY_PROVIDER', original);
    restoreEnv('GOPLUS_API_KEY', originalApiKey);
  });

  test('GET /api/status reports disabled (not failed) when providers are explicitly none', async () => {
    const origBalances = process.env.TOKEN_BALANCES_PROVIDER;
    const origPrice = process.env.PRICE_PROVIDER;
    const origSecurity = process.env.TOKEN_SECURITY_PROVIDER;
    const origApproval = process.env.APPROVAL_PROVIDER;
    process.env.TOKEN_BALANCES_PROVIDER = 'none';
    process.env.PRICE_PROVIDER = 'none';
    process.env.TOKEN_SECURITY_PROVIDER = 'none';
    process.env.APPROVAL_PROVIDER = 'none';

    const response = await request(app).get('/api/status');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.tokenBalances.status, 'disabled');
    assert.strictEqual(response.body.prices.status, 'disabled');
    assert.strictEqual(response.body.risk.status, 'disabled');
    assert.strictEqual(response.body.approvals.status, 'disabled');

    restoreEnv('TOKEN_BALANCES_PROVIDER', origBalances);
    restoreEnv('PRICE_PROVIDER', origPrice);
    restoreEnv('TOKEN_SECURITY_PROVIDER', origSecurity);
    restoreEnv('APPROVAL_PROVIDER', origApproval);
  });
});
