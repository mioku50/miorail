import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import express from 'express';
import { clearX402FacilitatorStatusForTests, ExactEvmScheme } from '@mioagent/x402-gateway';
import { privateKeyToAccount } from 'viem/accounts';
import { InMemorySpendPermissionRepository, clearFuelReservationsForTests } from '@mioagent/autonomy';
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

async function fuelRepository(limit = 10) {
  const repository = new InMemorySpendPermissionRepository();
  await repository.create({
    id: 'fuel-permission',
    userId: 'default-user',
    chainId: 8453,
    asset: MAINNET_USDC,
    limit,
    spent: 0,
    whitelist: [MAINNET_USDC],
    expiresAt: Date.now() + 60_000,
    isActive: true,
  });
  return repository;
}

function activeFuelPermissionRow() {
  return {
    id: 'fuel-permission',
    userId: 'default-user',
    chainId: 8453,
    asset: MAINNET_USDC,
    limit: 10,
    spent: 0,
    whitelist: [MAINNET_USDC],
    expiresAt: new Date(Date.now() + 60_000),
    isActive: true,
    updatedAt: new Date(),
  };
}

function paymentResponseHeader(txHash = '0xpaid') {
  return Buffer.from(JSON.stringify({
    success: true,
    payer: '0x2222222222222222222222222222222222222222',
    transaction: txHash,
    network: 'eip155:8453',
  })).toString('base64');
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
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.data, 'This is premium mock data protected by x402 payment.');
  });
});

describe('x402 official smoke endpoint', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearX402FacilitatorStatusForTests();
    clearFuelReservationsForTests();
    mock.restoreAll();
  });

  it('reports connected facilitator config and no production MockFacilitator path', async () => {
    globalThis.fetch = async () => supportedResponse();
    const smokeApp = express();
    smokeApp.use('/x402', createX402Router({
      dbEnabled: false,
      env: configuredEnv(),
      runtimeMode: 'official',
    }));

    const res = await request(smokeApp).get('/x402/diagnostics');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.middlewareMode, 'official');
    assert.strictEqual(res.body.officialMiddlewareEnabled, true);
    assert.strictEqual(res.body.mockFacilitatorEnabled, false);
    assert.strictEqual(res.body.browserPaidFlowAvailable, true);
    assert.strictEqual(res.body.settleReady, true);
    assert.strictEqual(res.body.probeStatus, 'connected');
    assert.deepStrictEqual(res.body.supportedNetworks, ['eip155:8453']);
    assert.strictEqual(res.body.configured, true);
    assert.strictEqual(res.body.network, 'eip155:8453');
    assert.strictEqual(res.body.chainId, 8453);
    assert.strictEqual(res.body.asset, MAINNET_USDC);
    assert.strictEqual(res.body.payToConfigured, true);
    assert.strictEqual(res.body.builderCodeConfigured, true);
    assert.strictEqual(res.body.builderCodeAttribution, 'attached');
    assert.strictEqual(res.body.facilitatorAuthConfigured, true);
    assert.strictEqual(res.body.authSource, 'bearer_token');
    assert.strictEqual(res.body.facilitatorHost, 'facilitator.example.test');
    assert.strictEqual(res.body.smokeRoute, '/api/x402/smoke-paid');
    assert.strictEqual(res.body.smokeRouteAvailable, true);
    assert.strictEqual(JSON.stringify(res.body).includes('redacted-token'), false);
    assert.strictEqual(JSON.stringify(res.body).includes('https://facilitator.example.test'), false);
  });

  it('reports configured-but-not-settle-ready diagnostics when mainnet auth is missing', async () => {
    globalThis.fetch = async () => {
      return supportedResponse();
    };
    const smokeApp = express();
    smokeApp.use('/x402', createX402Router({
      dbEnabled: false,
      env: configuredEnv({
        X402_FACILITATOR_AUTH_TOKEN: undefined,
        X402_FACILITATOR_API_KEY: undefined,
        CDP_API_KEY: undefined,
        CDP_API_KEY_ID: undefined,
        CDP_API_KEY_SECRET: undefined,
      }),
      runtimeMode: 'official',
    }));

    const res = await request(smokeApp).get('/x402/diagnostics');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'facilitator_auth_required');
    assert.strictEqual(res.body.configured, true);
    assert.strictEqual(res.body.settleReady, false);
    assert.strictEqual(res.body.settleBlockedReason, 'facilitator_auth_missing');
    assert.strictEqual(res.body.browserPaidFlowAvailable, false);
    assert.strictEqual(res.body.smokeRouteAvailable, false);
    assert.strictEqual(JSON.stringify(res.body).includes('redacted-token'), false);
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
      dbEnabled: false,
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
    assert.strictEqual(paymentRequired.accepts[0].extra?.name, 'USD Coin');
    assert.strictEqual(paymentRequired.accepts[0].extra?.version, '2');
    assert.strictEqual(JSON.stringify(res.body).includes('redacted-token'), false);
  });

  it('allows ExactEvmScheme payer client to construct signed EIP-712 payment payload from /smoke-paid 402 response', async () => {
    clearX402FacilitatorStatusForTests();
    globalThis.fetch = async () => supportedResponse();
    const smokeApp = express();
    smokeApp.use('/x402', createX402Router({
      dbEnabled: false,
      env: configuredEnv(),
      runtimeMode: 'official',
    }));
    const res = await request(smokeApp).get('/x402/smoke-paid');
    assert.strictEqual(res.status, 402);
    const signer = privateKeyToAccount('0x4c9bfe115a2917b14b03301ea3f86d306125a581126cafe842d4bb719b0f7b06');
    const scheme = new ExactEvmScheme(signer);
    const payload = await scheme.createPaymentPayload(2, res.body.accepts[0]);
    assert.strictEqual(payload.x402Version, 2);
    assert.ok(payload.payload.authorization);
    assert.ok(payload.payload.signature);
    assert.strictEqual((payload.payload.authorization as Record<string, unknown>).value, '1000');
  });

  it('returns safe 503 when facilitator auth is missing before probing', async () => {
    clearX402FacilitatorStatusForTests();
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response('Unauthorized redacted-token', { status: 401 });
    };
    const smokeApp = express();
    smokeApp.use('/x402', createX402Router({
      dbEnabled: false,
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
    assert.strictEqual(res.body.errorCode, 'facilitator_auth_missing');
    assert.strictEqual(res.body.settleReady, false);
    assert.strictEqual(res.body.settleBlockedReason, 'facilitator_auth_missing');
    assert.strictEqual(fetchCalled, false);
    assert.strictEqual(JSON.stringify(res.body).includes('redacted-token'), false);
    assert.strictEqual(JSON.stringify(res.body).includes('Authorization'), false);
  });

  it('reports Builder Code attached or explicitly unavailable', async () => {
    globalThis.fetch = async () => supportedResponse();
    const attachedApp = express();
    attachedApp.use('/x402', createX402Router({
      dbEnabled: false,
      env: configuredEnv({ BUILDER_CODE: 'miorail' }),
      runtimeMode: 'official',
    }));
    const attached = await request(attachedApp).get('/x402/diagnostics');
    assert.strictEqual(attached.body.builderCodeConfigured, true);
    assert.strictEqual(attached.body.builderCodeAttribution, 'attached');
    assert.strictEqual(attached.body.eip712DomainAttached, true);
    assert.strictEqual(attached.body.eip712DomainName, 'USD Coin');
    assert.strictEqual(attached.body.eip712DomainVersion, '2');

    const unavailableApp = express();
    unavailableApp.use('/x402', createX402Router({
      dbEnabled: false,
      env: configuredEnv({ BUILDER_CODE: undefined }),
      runtimeMode: 'official',
    }));
    const unavailable = await request(unavailableApp).get('/x402/diagnostics');
    assert.strictEqual(unavailable.body.builderCodeConfigured, false);
    assert.strictEqual(unavailable.body.builderCodeAttribution, 'unavailable');
  });

  it('keeps ledger empty before paid settlement', async () => {
    const app = express();
    app.use('/x402', createX402Router({
      dbEnabled: false,
      env: configuredEnv(),
      runtimeMode: 'official',
    }));
    const res = await request(app).get('/x402/ledger');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(Array.isArray(res.body.entries), true);
    assert.strictEqual(res.body.entries.length, 0);
  });

  it('exposes browser paid action diagnostic fields and exposes payment response headers', async () => {
    globalThis.fetch = async () => supportedResponse();
    const app = express();
    app.use('/x402', createX402Router({
      dbEnabled: false,
      env: configuredEnv(),
      runtimeMode: 'official',
    }));
    const diag = await request(app).get('/x402/diagnostics');
    assert.strictEqual(diag.body.browserPaidFlowAvailable, true);
    assert.strictEqual(diag.body.browserPaidActionAvailable, true);
    assert.strictEqual(diag.body.settleReady, true);
    assert.strictEqual(diag.body.paymentResponseHeaderReadable, true);
    assert.strictEqual('lastBrowserRunId' in diag.body, true);
    assert.strictEqual('lastBrowserRunLedgerMatched' in diag.body, true);
  });

  it('keeps read-only scans free in x402 pricing', async () => {
    const app = express();
    app.use('/x402', createX402Router({
      dbEnabled: false,
      env: configuredEnv(),
      runtimeMode: 'official',
    }));

    const res = await request(app).get('/x402/pricing');
    assert.strictEqual(res.status, 200);
    const portfolioScan = res.body.pricing.find((row: any) => row.actionType === 'portfolio_scan');
    const inference = res.body.pricing.find((row: any) => row.actionType === 'inference_call');
    assert.strictEqual(portfolioScan.priceUsdc, '0');
    assert.notStrictEqual(inference.priceUsdc, '0');
  });

  it('exposes buyer fuel dashboard without requiring seller smoke payment', async () => {
    const app = express();
    app.use('/x402', createX402Router({
      dbEnabled: false,
      env: configuredEnv({ X402_BUYER_SMOKE_URL: 'https://paid-resource.example.test/smoke' }),
      runtimeMode: 'official',
    }));

    const res = await request(app).get('/x402/fuel');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.mode, 'buyer');
    assert.strictEqual(res.body.activePermission, null);
    assert.strictEqual(res.body.status, 'missing_permission');
    assert.strictEqual(res.body.buyerSmoke.configured, true);
    assert.strictEqual(res.body.buyerSmoke.urlHost, 'paid-resource.example.test');
  });

  it('returns a sanitized subscription owner wallet for Base Account fuel permission creation', async () => {
    const app = express();
    app.use('/x402', createX402Router({
      dbEnabled: false,
      env: configuredEnv(),
      runtimeMode: 'official',
      subscriptionOwnerWalletResolver: async () => ({
        address: '0x3333333333333333333333333333333333333333',
        walletName: 'miorail-fuel-owner',
        eoaAddress: '0x4444444444444444444444444444444444444444',
      }),
    }));

    const res = await request(app).get('/x402/fuel/subscription-owner');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'ready');
    assert.strictEqual(res.body.subscriptionOwner, '0x3333333333333333333333333333333333333333');
    assert.strictEqual(res.body.walletName, 'miorail-fuel-owner');
    assert.strictEqual(res.body.chainId, 8453);
    assert.strictEqual(res.body.asset, MAINNET_USDC);
    assert.strictEqual(JSON.stringify(res.body).includes('0x4444444444444444444444444444444444444444'), false);
  });

  it('subscription owner lookup fails closed when CDP wallet env is missing', async () => {
    const app = express();
    app.use('/x402', createX402Router({
      dbEnabled: false,
      env: configuredEnv(),
      runtimeMode: 'official',
    }));

    const res = await request(app).get('/x402/fuel/subscription-owner');
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.body.status, 'missing_config');
    assert.deepStrictEqual(res.body.missingConfig.sort(), ['CDP_API_KEY_ID', 'CDP_API_KEY_SECRET', 'CDP_WALLET_SECRET'].sort());
    assert.strictEqual(JSON.stringify(res.body).includes('redacted-token'), false);
  });

  it('persists browser-confirmed Base subscription id as active x402 fuel permission', async () => {
    globalThis.fetch = async () => supportedResponse();
    const repository = new InMemorySpendPermissionRepository();
    const app = express();
    app.use(express.json());
    app.use('/x402', createX402Router({
      dbEnabled: false,
      env: configuredEnv({ X402_BUYER_SMOKE_URL: 'https://paid-resource.example.test/smoke' }),
      runtimeMode: 'official',
      subscriptionOwnerWalletResolver: async () => ({
        address: '0x3333333333333333333333333333333333333333',
        walletName: 'miorail-fuel-owner',
      }),
      spendPermissionRepository: repository,
      findActiveFuelPermission: async () => repository.getById('real-subscription-1') || null,
    }));

    const createRes = await request(app).post('/x402/fuel/permission').send({
      id: 'real-subscription-1',
      subscriptionOwner: '0x3333333333333333333333333333333333333333',
      subscriptionPayer: '0x5555555555555555555555555555555555555555',
      recurringCharge: '10',
      periodInDays: 30,
      limitUsdc: '10',
      ttlHours: 720,
    });
    assert.strictEqual(createRes.status, 201, JSON.stringify(createRes.body));
    assert.strictEqual(createRes.body.activePermission.id, 'real-subscription-1');
    assert.strictEqual(createRes.body.activePermission.chainId, 8453);
    assert.strictEqual(createRes.body.activePermission.asset, MAINNET_USDC);
    assert.strictEqual(createRes.body.activePermission.limitUsdc, '10');
    assert.strictEqual(createRes.body.activePermission.spentUsdc, '0');

    const stored = await repository.getById('real-subscription-1');
    assert.strictEqual(stored?.id, 'real-subscription-1');
    assert.strictEqual(stored?.userId, 'default-user');
    assert.strictEqual(stored?.spent, 0);
    assert.strictEqual(stored?.isActive, true);

    const fuelRes = await request(app).get('/x402/fuel');
    assert.strictEqual(fuelRes.status, 200);
    assert.strictEqual(fuelRes.body.status, 'ready');
    assert.strictEqual(fuelRes.body.activePermission.id, 'real-subscription-1');
  });

  it('buyer smoke reaches paid fetch and fuel charge after browser permission is persisted', async () => {
    const repository = new InMemorySpendPermissionRepository();
    let paidFetchCalled = false;
    let chargeCalls = 0;
    const app = express();
    app.use(express.json());
    app.use('/x402', createX402Router({
      dbEnabled: false,
      env: configuredEnv({
        X402_BUYER_SMOKE_URL: 'https://paid-resource.example.test/smoke',
        X402_BUYER_SMOKE_AMOUNT_USDC: '0.001',
      }),
      runtimeMode: 'official',
      subscriptionOwnerWalletResolver: async () => ({
        address: '0x3333333333333333333333333333333333333333',
        walletName: 'miorail-fuel-owner',
      }),
      spendPermissionRepository: repository,
      findActiveFuelPermission: async () => repository.getById('real-subscription-2') || null,
      fuelChargeServiceFactory: () => ({
        reserve: async (input) => ({
          success: true,
          status: 'reserved',
          reservation: {
            id: 'reservation-real-sub',
            permissionId: input.permissionId,
            amount: input.amount,
            category: input.category,
            createdAt: new Date().toISOString(),
          },
        }),
        release: () => {},
        chargeReserved: async (input, reservation) => {
          chargeCalls++;
          const updated = await repository.incrementSpent(input.permissionId, input.amount, {
            txHash: '0xfuelcharge',
            confirmedAt: new Date().toISOString(),
          });
          return {
            success: Boolean(updated),
            permission: updated,
            reservation,
            chargeId: 'fuel-charge-real-sub',
            proof: { txHash: '0xfuelcharge', confirmedAt: new Date().toISOString() },
            status: updated ? 'settled' : 'limit_exhausted',
          };
        },
      }),
      buyerPaidFetch: async () => {
        paidFetchCalled = true;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'payment-response': paymentResponseHeader('0xoutgoing-real-sub') },
        });
      },
    }));

    const createRes = await request(app).post('/x402/fuel/permission').send({
      id: 'real-subscription-2',
      subscriptionOwner: '0x3333333333333333333333333333333333333333',
      subscriptionPayer: '0x5555555555555555555555555555555555555555',
      recurringCharge: '10',
      periodInDays: 30,
      limitUsdc: '10',
      ttlHours: 720,
    });
    assert.strictEqual(createRes.status, 201, JSON.stringify(createRes.body));

    const smokeRes = await request(app).post('/x402/buyer-smoke').send({});
    assert.strictEqual(smokeRes.status, 200, JSON.stringify(smokeRes.body));
    assert.strictEqual(smokeRes.body.status, 'settled');
    assert.strictEqual(smokeRes.body.fuelPermissionId, 'real-subscription-2');
    assert.strictEqual(smokeRes.body.txHash, '0xoutgoing-real-sub');
    assert.strictEqual(paidFetchCalled, true);
    assert.strictEqual(chargeCalls, 1);
  });

  it('buyer smoke returns controlled unavailable when payer signer is not configured', async () => {
    const repository = await fuelRepository();
    const app = express();
    app.use(express.json());
    app.use('/x402', createX402Router({
      dbEnabled: false,
      env: configuredEnv({ X402_BUYER_SMOKE_URL: 'https://paid-resource.example.test/smoke' }),
      runtimeMode: 'official',
      findActiveFuelPermission: async () => activeFuelPermissionRow(),
      spendPermissionRepository: repository,
    }));

    const res = await request(app).post('/x402/buyer-smoke').send({});
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.body.error, 'x402_buyer_unavailable');
    assert.strictEqual(res.body.errorCode, 'x402_buyer_payer_missing_config');
    assert.strictEqual(res.body.buyerPayer.status, 'missing_config');
    assert.strictEqual(JSON.stringify(res.body).includes('redacted-token'), false);
  });

  it('buyer smoke requires an active fuel permission before calling the paid resource', async () => {
    let paidFetchCalled = false;
    const app = express();
    app.use(express.json());
    app.use('/x402', createX402Router({
      dbEnabled: false,
      env: configuredEnv({ X402_BUYER_SMOKE_URL: 'https://paid-resource.example.test/smoke' }),
      runtimeMode: 'official',
      buyerPaidFetch: async () => {
        paidFetchCalled = true;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    }));

    const res = await request(app).post('/x402/buyer-smoke').send({});
    assert.strictEqual(res.status, 402);
    assert.strictEqual(res.body.error, 'fuel_permission_required');
    assert.strictEqual(res.body.status, 'missing_permission');
    assert.strictEqual(paidFetchCalled, false);
  });

  it('buyer smoke records outgoing x402 tx and charges reserved fuel after durable proof', async () => {
    const repository = await fuelRepository();
    let chargeCalls = 0;

    let paidFetchCalled = false;
    const app = express();
    app.use(express.json());
    app.use('/x402', createX402Router({
      dbEnabled: false,
      env: configuredEnv({
        X402_BUYER_SMOKE_URL: 'https://paid-resource.example.test/smoke',
        X402_BUYER_SMOKE_AMOUNT_USDC: '0.001',
      }),
      runtimeMode: 'official',
      findActiveFuelPermission: async () => activeFuelPermissionRow(),
      spendPermissionRepository: repository,
      fuelChargeServiceFactory: () => ({
        reserve: async (input) => ({
          success: true,
          status: 'reserved',
          reservation: {
            id: 'reservation-1',
            permissionId: input.permissionId,
            amount: input.amount,
            category: input.category,
            createdAt: new Date().toISOString(),
          },
        }),
        release: () => {},
        chargeReserved: async (input, reservation) => {
          chargeCalls++;
          const updated = await repository.incrementSpent(input.permissionId, input.amount, {
            txHash: '0xfuelcharge',
            confirmedAt: new Date().toISOString(),
          });
          return {
            success: Boolean(updated),
            permission: updated,
            reservation,
            chargeId: 'fuel-charge-1',
            proof: { txHash: '0xfuelcharge', confirmedAt: new Date().toISOString() },
            status: updated ? 'settled' : 'limit_exhausted',
          };
        },
      }),
      buyerPaidFetch: async () => {
        paidFetchCalled = true;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'payment-response': paymentResponseHeader('0xoutgoing') },
        });
      },
    }));

    const res = await request(app).post('/x402/buyer-smoke').send({});
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.status, 'settled');
    assert.strictEqual(res.body.txHash, '0xoutgoing');
    assert.strictEqual(res.body.fuelChargeTxHash, '0xfuelcharge');
    assert.strictEqual(res.body.receipt.txHash, '0xoutgoing');
    assert.strictEqual(res.body.receipt.fuelChargeTxHash, '0xfuelcharge');
    assert.strictEqual(paidFetchCalled, true);
    assert.strictEqual(chargeCalls, 1);

    const stored = await repository.getById('fuel-permission');
    assert.strictEqual(stored?.spent, 0.001);
  });

  it('smoke-paid mock mode records runId and filters ledger by runId', async () => {
    const app = express();
    app.use('/x402', createX402Router({
      dbEnabled: false,
      env: configuredEnv(),
      runtimeMode: 'mock',
    }));
    const runId = 'test-browser-run-123';
    const smokeRes = await request(app)
      .get(`/x402/smoke-paid?runId=${runId}`)
      .set('x-402-payment', Buffer.from(JSON.stringify({ receipt: 'valid-receipt-amount:1000000-runid' })).toString('base64'));
    assert.strictEqual(smokeRes.status, 200);
    assert.strictEqual(smokeRes.body.runId, runId);

    const diag = await request(app).get('/x402/diagnostics');
    assert.strictEqual(diag.body.lastBrowserRunId, runId);

    const ledgerAll = await request(app).get('/x402/ledger');
    assert.strictEqual(Array.isArray(ledgerAll.body.entries), true);

    const ledgerFiltered = await request(app).get(`/x402/ledger?runId=other-run-id`);
    assert.strictEqual(ledgerFiltered.status, 200);
    assert.strictEqual(ledgerFiltered.body.entries.length, 0);

    const ledgerCurrent = await request(app).get(`/x402/ledger?runId=${runId}`);
    assert.strictEqual(ledgerCurrent.status, 200);
    assert.strictEqual(ledgerCurrent.body.summary.totalSpentUsdc, '0.0000');
  });
});
