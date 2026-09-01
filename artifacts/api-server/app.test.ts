import test from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { app } from './app';

test('Express App', async (t) => {
  await t.test('GET /health returns 200 OK', async () => {
    const response = await request(app).get('/health');
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.body, { status: 'ok' });
  });

  await t.test('GET /not-found returns 404 Not Found', async () => {
    const response = await request(app).get('/not-found');
    assert.strictEqual(response.status, 404);
    assert.deepStrictEqual(response.body, { error: 'Not Found' });
  });

  await t.test('Sets X-Trace-Id header', async () => {
    const response = await request(app).get('/health');
    assert.ok(response.headers['x-trace-id']);
  });

  await t.test('Exposes x402 payment response headers for browser settlement proof', async () => {
    const response = await request(app)
      .options('/api/x402/smoke-paid')
      .set('Origin', 'https://miorail.xyz')
      .set('Access-Control-Request-Method', 'GET');
    assert.strictEqual(response.status, 204);
    assert.ok(response.headers['access-control-expose-headers']?.includes('payment-response'));
    assert.ok(response.headers['access-control-expose-headers']?.includes('x-payment-response'));
    assert.ok(response.headers['access-control-expose-headers']?.includes('PAYMENT-REQUIRED'));
  });

  await t.test('publishes path-specific MCP protected-resource metadata', async () => {
    const response = await request(app).get('/.well-known/oauth-protected-resource/mcp/private');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.resource, 'https://miorail.xyz/mcp/private');
    assert.deepStrictEqual(response.body.authorization_servers, ['https://miorail.xyz/']);
    assert.ok(response.body.scopes_supported.includes('miorail:connected'));
  });

  await t.test('publishes OAuth authorization, refresh, registration and revocation endpoints', async () => {
    const response = await request(app).get('/.well-known/oauth-authorization-server');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.authorization_endpoint, 'https://miorail.xyz/authorize');
    assert.strictEqual(response.body.token_endpoint, 'https://miorail.xyz/token');
    assert.strictEqual(response.body.registration_endpoint, 'https://miorail.xyz/register');
    assert.strictEqual(response.body.revocation_endpoint, 'https://miorail.xyz/revoke');
    assert.deepStrictEqual(response.body.code_challenge_methods_supported, ['S256']);
    assert.ok(response.body.grant_types_supported.includes('refresh_token'));
  });
});
