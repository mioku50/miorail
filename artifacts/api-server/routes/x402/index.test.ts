import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import express from 'express';
import { clearX402FacilitatorStatusForTests } from '@mioagent/x402-gateway';
import { createX402Router, x402Router } from './index.js';

const app = express();
app.use('/x402', x402Router);

const MAINNET_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAY_TO = '0x1111111111111111111111111111111111111111';

function configuredEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    X402_FACILITATOR_URL: 'https://facilitator.example.test',
    X402_PAYTO_ADDRESS: PAY_TO,
    X402_NETWORK: 'eip155:8453',
    X402_FACILITATOR_AUTH_TOKEN: 'redacted-token',
    BUILDER_CODE: 'miorail',
    ...overrides,
  };
}

function supportedResponse() {
  return new Response(JSON.stringify({
    kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }],
    extensions: [],
    signers: {},
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function extractPaymentRequired(res: request.Response): any {
  if (res.body?.paymentRequired) return res.body.paymentRequired;
  if (Array.isArray(res.body?.accepts)) return res.body;
  for (const headerName of ['payment-required', 'x-payment-required', 'x-payment-requirements']) {
    const value = res.headers[headerName];
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        if (parsed?.paymentRequired) return parsed.paymentRequired;
        if (Array.isArray(parsed?.accepts)) return parsed;
      } catch {
        // Ignore unknown SDK header shapes; the JSON body remains canonical for these tests.
      }
    }
  }
  return undefined;
}

describe('x402 mock endpoint', () => {
  it('returns 402 with Payment-Required header when missing X-402-Payment', async () => {
    const res = await request(app).get('/x402/mock-paid-endpoint');
    assert.strictEqual(res.status, 402);
    assert.strictEqual(res.body.error, 'Payment Required');
    assert.ok(res.headers['payment-required']);
  });

  it('returns 400 for invalid X-402-Payment header', async () => {
    const res = await request(app)
      .get('/x402/mock-paid-endpoint')
      .set('x-402-payment', Buffer.from(JSON.stringify({ notReceipt: true })).toString('base64'));
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'Invalid X-402-Payment header: missing receipt');
  });

  it('returns 200 for valid X-402-Payment header', async () => {
    const res = await request(app)
      .get('/x402/mock-paid-endpoint')
      .set('x-402-payment', Buffer.from(JSON.stringify({ receipt: 'valid-receipt-amount:1000000' })).toString('base64'));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data, 'This is premium mock data protected by x402 payment.');
  });
});

describe('x402 official smoke endpoint', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearX402FacilitatorStatusForTests();
  });

  it('reports connected facilitator config and no production MockFacilitator path', async () => {
    const smokeApp = express();
    smokeApp.use('/x402', createX402Router({
      env: configuredEnv(),
      runtimeMode: 'official',
    }));

    const res = await request(smokeApp).get('/x402/diagnostics');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.middlewareMode, 'official');
    assert.strictEqual(res.body.officialMiddlewareEnabled, true);
    assert.strictEqual(res.body.mockFacilitatorEnabled, false);
    assert.strictEqual(res.body.configured, true);
    assert.strictEqual(res.body.network, 'eip155:8453');
    assert.strictEqual(res.body.chainId, 8453);
    assert.strictEqual(res.body.asset, MAINNET_USDC);
    assert.strictEqual(res.body.payToConfigured, true);
    assert.strictEqual(res.body.builderCodeConfigured, true);
    assert.strictEqual(res.body.builderCodeAttribution, 'attached');
    assert.strictEqual(res.body.facilitatorAuthConfigured, true);
    assert.strictEqual(res.body.authSource, 'bearer_token');
    assert.strictEqual(res.body.smokeRoute, '/api/x402/smoke-paid');
    assert.strictEqual(res.body.smokeRouteAvailable, true);
    assert.strictEqual(JSON.stringify(res.body).includes('redacted-token'), false);
    assert.strictEqual(JSON.stringify(res.body).includes('facilitator.example.test'), false);
  });

  it('returns controlled official 402 Payment Required for unpaid smoke request', async () => {
    clearX402FacilitatorStatusForTests();
    globalThis.fetch = async (input, init) => {
      assert.ok(String(input).endsWith('/supported'));
      assert.strictEqual((init?.headers as Record<string, string>).Authorization, 'Bearer redacted-token');
      return supportedResponse();
    };
    const smokeApp = express();
    smokeApp.use('/x402', createX402Router({
      env: configuredEnv(),
      runtimeMode: 'official',
    }));

    const res = await request(smokeApp).get('/x402/smoke-paid');
    assert.strictEqual(res.status, 402);
    assert.notStrictEqual(res.status, 500);
    assert.notStrictEqual(res.status, 503);
    assert.strictEqual(res.body.error, 'Payment Required');
    assert.strictEqual(res.body.x402Version, 2);
    assert.strictEqual(Array.isArray(res.body.accepts), true);
    assert.ok(res.body.accepts.length > 0);
    assert.strictEqual(res.body.paymentRequired, undefined);
    const paymentRequired = extractPaymentRequired(res);
    assert.ok(paymentRequired);
    assert.strictEqual(paymentRequired.accepts[0].network, 'eip155:8453');
    assert.strictEqual(paymentRequired.accepts[0].asset, MAINNET_USDC);
    assert.strictEqual(paymentRequired.accepts[0].payTo, PAY_TO);
    assert.strictEqual(paymentRequired.accepts[0].amount, '1000');
    assert.strictEqual(JSON.stringify(res.body).includes('redacted-token'), false);
  });

  it('returns safe 503 when facilitator auth is missing or rejected', async () => {
    clearX402FacilitatorStatusForTests();
    globalThis.fetch = async () => new Response('Unauthorized redacted-token', { status: 401 });
    const smokeApp = express();
    smokeApp.use('/x402', createX402Router({
      env: configuredEnv({
        X402_FACILITATOR_AUTH_TOKEN: undefined,
        X402_FACILITATOR_API_KEY: undefined,
        CDP_API_KEY: undefined,
        CDP_API_KEY_ID: undefined,
        CDP_API_KEY_SECRET: undefined,
      }),
      runtimeMode: 'official',
    }));

    const res = await request(smokeApp).get('/x402/smoke-paid');
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.body.error, 'x402_facilitator_unavailable');
    assert.strictEqual(res.body.status, 'facilitator_auth_required');
    assert.strictEqual(res.body.errorCode, 'facilitator_401');
    assert.strictEqual(JSON.stringify(res.body).includes('redacted-token'), false);
    assert.strictEqual(JSON.stringify(res.body).includes('Authorization'), false);
  });

  it('reports Builder Code attached or explicitly unavailable', async () => {
    const attachedApp = express();
    attachedApp.use('/x402', createX402Router({
      env: configuredEnv({ BUILDER_CODE: 'miorail' }),
      runtimeMode: 'official',
    }));
    const attached = await request(attachedApp).get('/x402/diagnostics');
    assert.strictEqual(attached.body.builderCodeConfigured, true);
    assert.strictEqual(attached.body.builderCodeAttribution, 'attached');

    const unavailableApp = express();
    unavailableApp.use('/x402', createX402Router({
      env: configuredEnv({ BUILDER_CODE: undefined }),
      runtimeMode: 'official',
    }));
    const unavailable = await request(unavailableApp).get('/x402/diagnostics');
    assert.strictEqual(unavailable.body.builderCodeConfigured, false);
    assert.strictEqual(unavailable.body.builderCodeAttribution, 'unavailable');
  });
});
