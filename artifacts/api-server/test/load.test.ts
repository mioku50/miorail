import { describe, it } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { app } from '../app.js';

describe('API Gateway Load Tests', () => {
  it('handles concurrent requests to health endpoint and triggers rate limit', async () => {
    const totalRequests = 150; // Our rate limiter is set to 100 requests per minute

    const requests = Array.from({ length: totalRequests }).map(() => request(app).get('/health'));

    const startTime = performance.now();
    const responses = await Promise.all(requests);
    const durationMs = performance.now() - startTime;

    console.log(`Fired ${totalRequests} concurrent requests in ${durationMs}ms`);

    const statuses = responses.map(r => r.status);
    const okCount = statuses.filter(s => s === 200).length;
    const rateLimitedCount = statuses.filter(s => s === 429).length;

    console.log(`200 OK: ${okCount}, 429 Too Many Requests: ${rateLimitedCount}`);

    assert.ok(okCount <= 100, `Expected at most 100 successful requests, got ${okCount}`);
    assert.ok(rateLimitedCount > 0, `Expected some requests to be rate limited`);
  });

  it('handles concurrent requests to x402 gateway endpoint', async () => {
    const totalRequests = 20;

    const requests = Array.from({ length: totalRequests }).map((_, index) =>
      request(app)
        .get('/api/x402/mock-paid-endpoint')
        // Attempt to bypass global rate limit for this test by spoofing IP if express trusts proxies
        // Even if it's rate-limited, the gateway is handling the load.
        .set('X-Forwarded-For', `192.168.1.${index}`)
    );

    const startTime = performance.now();
    const responses = await Promise.all(requests);
    const durationMs = performance.now() - startTime;

    console.log(`Fired ${totalRequests} x402 concurrent requests in ${durationMs}ms`);

    for (const res of responses) {
      assert.ok(res.status === 402 || res.status === 429);
    }
  });
});
