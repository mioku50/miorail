import { describe, it } from 'node:test';
import assert from 'node:assert';
import { generateKeyPairSync } from 'node:crypto';
import express, { Request, Response as ExpressResponse } from 'express';
import request from 'supertest';
import { privateKeyToAccount } from 'viem/accounts';
import { ExactEvmScheme } from '@x402/evm';
import { encodeBuilderCodeSuffix } from '@x402/extensions/builder-code';
import {
  x402Gateway,
  MockFacilitator,
  createX402RoutesConfig,
  createX402FacilitatorAuthHeaders,
  createSafeOfficialX402Middleware,
  clearX402FacilitatorStatusForTests,
  classifyX402FacilitatorError,
  paymentRequiredFromRuntimeConfig,
  resolveEip712DomainExtra,
  resolveX402FacilitatorAuth,
  settlementRecordFromSettleResult,
  verifyBuilderCodeAttributionFromCalldata,
  x402ConfigFromEnv,
  x402StatusFromEnv,
} from './index.js';

function testEcPrivateKey(): string {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

describe('x402-gateway', () => {
  const paymentRequired = {
    accepts: [
      {
        amount: '1000000',
        payTo: '0x1234',
        asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e', // USDC on Base Sepolia
        network: '84532', // Base Sepolia
      }
    ]
  };

  const app = express();
  const facilitator = new MockFacilitator();
  const gateway = x402Gateway({ paymentRequired, facilitator });

  app.get('/protected', gateway, (req: Request, res: ExpressResponse) => {
    res.status(200).json({ data: 'success' });
  });

  it('returns 402 with Payment-Required header when missing X-402-Payment', async () => {
    const res = await request(app).get('/protected');
    assert.strictEqual(res.status, 402);
    assert.deepStrictEqual(JSON.parse(res.headers['payment-required']), paymentRequired);
    assert.strictEqual(res.body.error, 'Payment Required');
  });

  it('returns 400 for invalid X-402-Payment header json', async () => {
    const res = await request(app)
      .get('/protected')
      .set('x-402-payment', 'invalid-base64');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'Invalid X-402-Payment header');
  });

  it('returns 400 for missing receipt', async () => {
    const res = await request(app)
      .get('/protected')
      .set('x-402-payment', Buffer.from(JSON.stringify({ notReceipt: true })).toString('base64'));
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'Invalid X-402-Payment header: missing receipt');
  });

  it('returns 402 for invalid receipt', async () => {
    const res = await request(app)
      .get('/protected')
      .set('x-402-payment', Buffer.from(JSON.stringify({ receipt: 'bad-receipt' })).toString('base64'));
    assert.strictEqual(res.status, 402);
    assert.strictEqual(res.body.error, 'Payment Required: Invalid or used receipt');
  });

  it('returns 200 for valid receipt', async () => {
    const validReceipt = 'valid-receipt-amount:1000000';
    const res = await request(app)
      .get('/protected')
      .set('x-402-payment', Buffer.from(JSON.stringify({ receipt: validReceipt })).toString('base64'));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data, 'success');
  });

  it('returns 402 for reused receipt (anti-replay)', async () => {
    const validReceipt = 'valid-receipt-amount:1000000-2';
    // First request succeeds
    await request(app)
      .get('/protected')
      .set('x-402-payment', Buffer.from(JSON.stringify({ receipt: validReceipt })).toString('base64'));

    // Second request with same receipt fails
    const res2 = await request(app)
      .get('/protected')
      .set('x-402-payment', Buffer.from(JSON.stringify({ receipt: validReceipt })).toString('base64'));

    assert.strictEqual(res2.status, 402);
    assert.strictEqual(res2.body.error, 'Payment Required: Invalid or used receipt');
  });

  it('fails closed when real x402 env is missing or invalid', () => {
    const missing = x402ConfigFromEnv({});
    assert.strictEqual(missing.status, 'simulated');
    assert.strictEqual(missing.configured, false);

    const invalid = x402ConfigFromEnv({
      X402_FACILITATOR_URL: 'https://facilitator.example.test',
      X402_PAYTO_ADDRESS: '0x1234',
      X402_NETWORK: 'eip155:1',
    });
    assert.strictEqual(invalid.status, 'missing');
    assert.strictEqual(invalid.configured, false);
    assert.ok(invalid.missingConfig.includes('X402_PAYTO_ADDRESS'));
    assert.ok(invalid.missingConfig.includes('X402_NETWORK'));
  });

  it('classifies facilitator auth, rate limit, and network errors without raw secrets', () => {
    assert.deepStrictEqual(
      classifyX402FacilitatorError(new Error('Facilitator getSupported failed (401): Unauthorized token-secret')),
      { status: 'facilitator_auth_required', errorCode: 'facilitator_401' },
    );
    assert.deepStrictEqual(
      classifyX402FacilitatorError(new Error('Facilitator getSupported failed (429): Too Many Requests')),
      { status: 'facilitator_rate_limited', errorCode: 'facilitator_429' },
    );
    assert.deepStrictEqual(
      classifyX402FacilitatorError(new Error('fetch failed ECONNRESET')),
      { status: 'facilitator_unreachable', errorCode: 'facilitator_network' },
    );
  });

  it('keeps explicit bearer token override ahead of CDP API key pair auth', async () => {
    clearX402FacilitatorStatusForTests();
    const config = x402ConfigFromEnv({
      X402_FACILITATOR_URL: 'https://api.cdp.coinbase.com/platform/v2/x402',
      X402_PAYTO_ADDRESS: '0x1111111111111111111111111111111111111111',
      X402_NETWORK: 'eip155:8453',
      X402_FACILITATOR_AUTH_TOKEN: 'override-token',
      CDP_API_KEY_ID: 'organizations/example/apiKeys/key',
      CDP_API_KEY_SECRET: testEcPrivateKey(),
    });
    const auth = resolveX402FacilitatorAuth({
      X402_FACILITATOR_AUTH_TOKEN: 'override-token',
      CDP_API_KEY_ID: 'organizations/example/apiKeys/key',
      CDP_API_KEY_SECRET: testEcPrivateKey(),
    });
    const headers = await createX402FacilitatorAuthHeaders({
      X402_FACILITATOR_AUTH_TOKEN: 'override-token',
      CDP_API_KEY_ID: 'organizations/example/apiKeys/key',
      CDP_API_KEY_SECRET: testEcPrivateKey(),
    }, config)?.();

    assert.strictEqual(auth.configured, true);
    assert.strictEqual(auth.source, 'bearer_token');
    assert.strictEqual(config.authSource, 'bearer_token');
    assert.strictEqual(headers?.supported.Authorization, 'Bearer override-token');
    assert.strictEqual(headers?.verify.Authorization, 'Bearer override-token');
  });

  it('generates CDP Bearer JWT auth headers for facilitator endpoints', async () => {
    clearX402FacilitatorStatusForTests();
    const secret = testEcPrivateKey();
    const env = {
      X402_FACILITATOR_URL: 'https://api.cdp.coinbase.com/platform/v2/x402?ignored=secret',
      X402_PAYTO_ADDRESS: '0x1111111111111111111111111111111111111111',
      X402_NETWORK: 'eip155:8453',
      CDP_API_KEY_ID: 'organizations/example/apiKeys/key',
      CDP_API_KEY_SECRET: secret.replace(/\n/g, '\\n'),
    };
    const config = x402ConfigFromEnv(env);
    const headers = await createX402FacilitatorAuthHeaders(env, config)?.();
    const supportedJwt = headers?.supported.Authorization?.replace(/^Bearer +/, '');
    const settleJwt = headers?.settle.Authorization?.replace(/^Bearer +/, '');
    assert.ok(supportedJwt);
    assert.ok(settleJwt);
    assert.notStrictEqual(supportedJwt, settleJwt);
    assert.strictEqual(config.facilitatorAuthConfigured, true);
    assert.strictEqual(config.authSource, 'cdp_api_key_pair');

    const supportedPayload = decodeJwtPayload(supportedJwt);
    assert.strictEqual(supportedPayload.sub, 'organizations/example/apiKeys/key');
    assert.deepStrictEqual(supportedPayload.uris, ['GET api.cdp.coinbase.com/platform/v2/x402/supported']);

    const settlePayload = decodeJwtPayload(settleJwt);
    assert.deepStrictEqual(settlePayload.uris, ['POST api.cdp.coinbase.com/platform/v2/x402/settle']);
    assert.strictEqual(JSON.stringify(headers).includes(secret), false);
  });

  it('classifies incomplete CDP API key pair safely without probing facilitator', async () => {
    clearX402FacilitatorStatusForTests();
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return new globalThis.Response('{}', { status: 200 });
    };
    try {
      const status = await x402StatusFromEnv({
        X402_FACILITATOR_URL: 'https://api.cdp.coinbase.com/platform/v2/x402',
        X402_PAYTO_ADDRESS: '0x1111111111111111111111111111111111111111',
        X402_NETWORK: 'eip155:8453',
        CDP_API_KEY_ID: 'organizations/example/apiKeys/key',
      });
      assert.strictEqual(status.status, 'facilitator_auth_required');
      assert.strictEqual(status.errorCode, 'cdp_api_key_pair_incomplete');
      assert.strictEqual(status.facilitatorAuthConfigured, false);
      assert.strictEqual(status.authSource, undefined);
      assert.strictEqual(called, false);
    } finally {
      globalThis.fetch = originalFetch;
      clearX402FacilitatorStatusForTests();
    }
  });

  it('requires facilitator auth for Base Mainnet settlement before probing /supported', async () => {
    clearX402FacilitatorStatusForTests();
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return new globalThis.Response('{}', { status: 200 });
    };
    try {
      const status = await x402StatusFromEnv({
        X402_FACILITATOR_URL: 'https://facilitator.example.test',
        X402_PAYTO_ADDRESS: '0x1111111111111111111111111111111111111111',
        X402_NETWORK: 'eip155:8453',
        BUILDER_CODE: 'miorail',
      });
      assert.strictEqual(status.configured, true);
      assert.strictEqual(status.status, 'facilitator_auth_required');
      assert.strictEqual(status.settleReady, false);
      assert.strictEqual(status.settleBlockedReason, 'facilitator_auth_missing');
      assert.strictEqual(status.errorCode, 'facilitator_auth_missing');
      assert.strictEqual(called, false);
    } finally {
      globalThis.fetch = originalFetch;
      clearX402FacilitatorStatusForTests();
    }
  });

  it('classifies invalid CDP API key secret without crashing startup', async () => {
    clearX402FacilitatorStatusForTests();
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return new globalThis.Response('{}', { status: 200 });
    };
    try {
      const status = await x402StatusFromEnv({
        X402_FACILITATOR_URL: 'https://api.cdp.coinbase.com/platform/v2/x402',
        X402_PAYTO_ADDRESS: '0x1111111111111111111111111111111111111111',
        X402_NETWORK: 'eip155:8453',
        CDP_API_KEY_ID: 'organizations/example/apiKeys/key',
        CDP_API_KEY_SECRET: 'not-a-valid-cdp-secret',
      });
      assert.strictEqual(status.status, 'facilitator_auth_invalid');
      assert.strictEqual(status.errorCode, 'cdp_jwt_generation_failed');
      assert.strictEqual(status.facilitatorAuthConfigured, true);
      assert.strictEqual(status.authSource, 'cdp_api_key_pair');
      assert.strictEqual(called, false);
    } finally {
      globalThis.fetch = originalFetch;
      clearX402FacilitatorStatusForTests();
    }
  });

  it('reports facilitator auth required when configured facilitator returns 401', async () => {
    clearX402FacilitatorStatusForTests();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new globalThis.Response('Unauthorized secret-token', { status: 401 });
    const env = {
      X402_FACILITATOR_URL: 'https://facilitator.example.test/private?token=secret',
      X402_PAYTO_ADDRESS: '0x1111111111111111111111111111111111111111',
      X402_NETWORK: 'eip155:8453',
      BUILDER_CODE: 'miorail',
      X402_FACILITATOR_AUTH_TOKEN: 'secret-token',
      X402_FACILITATOR_TIMEOUT_MS: '100',
    };
    try {
      const status = await x402StatusFromEnv(env);
      assert.strictEqual(status.configured, true);
      assert.strictEqual(status.status, 'facilitator_auth_required');
      assert.strictEqual(status.errorCode, 'facilitator_401');
      assert.strictEqual(status.facilitatorAuthConfigured, true);
      assert.strictEqual(JSON.stringify(status).includes('secret-token'), false);
    } finally {
      globalThis.fetch = originalFetch;
      clearX402FacilitatorStatusForTests();
    }
  });

  it('does not call facilitator when payTo/network config is missing', async () => {
    clearX402FacilitatorStatusForTests();
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return new globalThis.Response('{}', { status: 500 });
    };
    try {
      const status = await x402StatusFromEnv({
        X402_FACILITATOR_URL: 'https://facilitator.example.test',
      });
      assert.strictEqual(status.status, 'missing');
      assert.strictEqual(status.configured, false);
      assert.strictEqual(called, false);
    } finally {
      globalThis.fetch = originalFetch;
      clearX402FacilitatorStatusForTests();
    }
  });

  it('reports connected when facilitator supported probe succeeds', async () => {
    clearX402FacilitatorStatusForTests();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      assert.ok(String(input).endsWith('/supported'));
      assert.strictEqual((init?.headers as Record<string, string>).Authorization, 'Bearer secret-token');
      return new globalThis.Response(JSON.stringify({
        kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }],
        extensions: [],
        signers: {},
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    try {
      const status = await x402StatusFromEnv({
        X402_FACILITATOR_URL: 'https://facilitator.example.test',
        X402_PAYTO_ADDRESS: '0x1111111111111111111111111111111111111111',
        X402_NETWORK: 'eip155:8453',
        BUILDER_CODE: 'miorail',
        X402_FACILITATOR_AUTH_TOKEN: 'secret-token',
      });
      assert.strictEqual(status.status, 'connected');
      assert.strictEqual(status.settleReady, true);
      assert.strictEqual(status.supportedKindsCount, 1);
      assert.deepStrictEqual(status.supportedNetworks, ['eip155:8453']);
      assert.strictEqual(status.errorCode, undefined);
    } finally {
      globalThis.fetch = originalFetch;
      clearX402FacilitatorStatusForTests();
    }
  });

  it('blocks settlement when facilitator /supported omits the configured network', async () => {
    clearX402FacilitatorStatusForTests();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new globalThis.Response(JSON.stringify({
      kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:84532' }],
      extensions: [],
      signers: {},
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    try {
      const status = await x402StatusFromEnv({
        X402_FACILITATOR_URL: 'https://facilitator.example.test',
        X402_PAYTO_ADDRESS: '0x1111111111111111111111111111111111111111',
        X402_NETWORK: 'eip155:8453',
        BUILDER_CODE: 'miorail',
        X402_FACILITATOR_AUTH_TOKEN: 'secret-token',
      });
      assert.strictEqual(status.status, 'unsupported_network_for_settlement');
      assert.strictEqual(status.probeStatus, 'connected');
      assert.strictEqual(status.settleReady, false);
      assert.strictEqual(status.settleBlockedReason, 'network_not_supported');
      assert.deepStrictEqual(status.supportedNetworks, ['eip155:84532']);
    } finally {
      globalThis.fetch = originalFetch;
      clearX402FacilitatorStatusForTests();
    }
  });

  it('returns controlled unavailable response when official route cannot initialize facilitator', async () => {
    clearX402FacilitatorStatusForTests();
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(JSON.stringify(args));
    };
    globalThis.fetch = async () => new globalThis.Response('Unauthorized secret-token', { status: 401 });
    const env = {
      X402_FACILITATOR_URL: 'https://facilitator.example.test',
      X402_PAYTO_ADDRESS: '0x1111111111111111111111111111111111111111',
      X402_NETWORK: 'eip155:8453',
      BUILDER_CODE: 'miorail',
      X402_FACILITATOR_AUTH_TOKEN: 'secret-token',
      X402_FACILITATOR_TIMEOUT_MS: '100',
    };
    const config = x402ConfigFromEnv(env);
    const paidApp = express();
    paidApp.get('/paid', createSafeOfficialX402Middleware(config, { routePath: '/paid' }, env), (_req, res) => {
      res.json({ data: 'paid' });
    });
    try {
      const res = await request(paidApp).get('/paid');
      assert.strictEqual(res.status, 503);
      assert.strictEqual(res.body.error, 'x402_facilitator_unavailable');
      assert.strictEqual(res.body.status, 'facilitator_auth_required');
      assert.strictEqual(res.body.errorCode, 'facilitator_401');
      assert.strictEqual(JSON.stringify(res.body).includes('secret-token'), false);
      assert.strictEqual(warnings.join('\n').includes('secret-token'), false);
    } finally {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
      clearX402FacilitatorStatusForTests();
    }
  });

  it('builds payment requirements from supported Base network and canonical USDC', () => {
    const config = x402ConfigFromEnv({
      X402_FACILITATOR_URL: 'https://facilitator.example.test',
      X402_PAYTO_ADDRESS: '0x1111111111111111111111111111111111111111',
      X402_NETWORK: 'eip155:8453',
      X402_AMOUNT_ATOMIC_USDC: '2500',
      BUILDER_CODE: 'miorail',
      X402_FACILITATOR_AUTH_TOKEN: 'secret-token',
    });
    assert.strictEqual(config.status, 'configured');
    assert.strictEqual(config.network, 'eip155:8453');
    assert.strictEqual(config.asset, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    assert.strictEqual(config.amountAtomic, '2500');

    const paymentRequired = paymentRequiredFromRuntimeConfig(config);
    assert.strictEqual(paymentRequired.accepts[0].network, 'eip155:8453');
    assert.strictEqual(paymentRequired.accepts[0].asset, config.asset);
    assert.strictEqual(paymentRequired.accepts[0].amount, '2500');
    assert.strictEqual(paymentRequired.accepts[0].extra?.name, 'USD Coin');
    assert.strictEqual(paymentRequired.accepts[0].extra?.version, '2');
  });

  it('creates EIP-712 ExactEvmScheme payment payload from paymentRequired without domain parameter error', async () => {
    const config = x402ConfigFromEnv({
      X402_FACILITATOR_URL: 'https://facilitator.example.test',
      X402_PAYTO_ADDRESS: '0x1111111111111111111111111111111111111111',
      X402_NETWORK: 'eip155:8453',
      X402_AMOUNT_ATOMIC_USDC: '1000',
      BUILDER_CODE: 'miorail',
      X402_FACILITATOR_AUTH_TOKEN: 'secret-token',
    });
    const paymentRequired = paymentRequiredFromRuntimeConfig(config);
    const account = privateKeyToAccount('0x4c9bfe115a2917b14b03301ea3f86d306125a581126cafe842d4bb719b0f7b06');
    const scheme = new ExactEvmScheme(account);
    const payload = await scheme.createPaymentPayload(2, paymentRequired.accepts[0] as any);
    assert.ok(payload);
    assert.strictEqual(payload.x402Version, 2);
    assert.ok(payload.payload.authorization);
    assert.ok(payload.payload.signature);
    assert.strictEqual((payload.payload.authorization as Record<string, unknown>).value, '1000');
  });

  it('declares Builder Code seller extension in official route config', () => {
    const config = x402ConfigFromEnv({
      X402_FACILITATOR_URL: 'https://facilitator.example.test',
      X402_PAYTO_ADDRESS: '0x1111111111111111111111111111111111111111',
      X402_NETWORK: 'eip155:84532',
      BUILDER_CODE: 'miorail',
    });
    const routes = createX402RoutesConfig(config);
    const route = (routes as Record<string, any>)['GET /mock-paid-endpoint'];
    assert.strictEqual(route.extensions['builder-code'].info.a, 'miorail');
    assert.strictEqual(route.accepts.network, 'eip155:84532');
    assert.strictEqual(route.accepts.price.asset, '0x036CbD53842c5426634e7929541eC2318f3dCF7e');
  });

  it('verifies Builder Code suffix roles from calldata', () => {
    const suffix = encodeBuilderCodeSuffix({ a: 'miorail', s: ['buyer_app'] });
    const calldata = `0x1234${suffix.slice(2)}` as const;
    assert.strictEqual(verifyBuilderCodeAttributionFromCalldata(calldata, 'miorail', 'seller'), true);
    assert.strictEqual(verifyBuilderCodeAttributionFromCalldata(calldata, 'buyer_app', 'buyer'), true);
    assert.strictEqual(verifyBuilderCodeAttributionFromCalldata(calldata, 'other', 'buyer'), false);
  });

  it('normalizes settled facilitator records for ledger storage', () => {
    const config = x402ConfigFromEnv({
      X402_FACILITATOR_URL: 'https://facilitator.example.test',
      X402_PAYTO_ADDRESS: '0x1111111111111111111111111111111111111111',
      X402_NETWORK: 'eip155:8453',
      X402_AMOUNT_ATOMIC_USDC: '1000',
      BUILDER_CODE: 'miorail',
      X402_FACILITATOR_AUTH_TOKEN: 'secret-token',
    });
    const record = settlementRecordFromSettleResult(
      {
        success: true,
        transaction: '0xabc',
        network: 'eip155:8453',
        amount: '1000',
        extensions: { 'builder-code': { a: 'miorail', s: ['buyer_app'] } },
      },
      {
        asset: config.asset,
        amount: config.amountAtomic,
        payTo: config.payTo,
      },
      config,
      '2026-07-08T00:00:00.000Z',
    );
    assert.strictEqual(record.status, 'settled');
    assert.strictEqual(record.txHash, '0xabc');
    assert.strictEqual(record.asset, config.asset);
    assert.strictEqual(record.attribution.sellerVerified, true);
    assert.strictEqual(record.checkedAt, '2026-07-08T00:00:00.000Z');
  });

  it('derives correct EIP-712 domain name and version for Base USDC', () => {
    const domain = resolveEip712DomainExtra('eip155:8453', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    assert.strictEqual(domain.name, 'USD Coin');
    assert.strictEqual(domain.version, '2');
  });
});
