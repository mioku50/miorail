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
});
