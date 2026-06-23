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
});
