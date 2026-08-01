import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import {
  decodeX402PaymentResponseHeader,
  hasSupportedWalletClient,
  mapPaidActionError,
  paidActionButtonLabel,
  paidActionCopy,
  runX402PaidFetch,
} from '../src/paidFetch.js';

// T67X-A3: these mocks now answer the way the real resource server answers —
// a PAYMENT-REQUIRED header carrying the full v2 envelope, `scheme` and
// `resource` included. They used to omit both, which passed only because the
// client repaired the response before reading it. A mock that is easier to
// satisfy than the server is a mock that hides the bug.
const paymentRequired = {
  x402Version: 2,
  resource: { url: 'http://localhost/api/x402/smoke-paid', description: 'x402 protected resource' },
  accepts: [{
    scheme: 'exact',
    amount: '1000',
    payTo: '0x8e525BfCe1eF40Aa8075ef64E45421b5855C8909',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    network: 'eip155:8453',
    maxTimeoutSeconds: 300,
    extra: { name: 'USD Coin', version: '2' },
  }],
  error: 'Payment Required',
};

/** A 402 shaped exactly like the one `createX402MiddlewareFromEnv` emits. */
function paymentRequiredResponse(): Response {
  return new Response(JSON.stringify(paymentRequired), {
    status: 402,
    headers: {
      'content-type': 'application/json',
      'PAYMENT-REQUIRED': encodePaymentRequiredHeader(paymentRequired as never),
    },
  });
}

function paymentResponseHeader() {
  return Buffer.from(JSON.stringify({
    success: true,
    payer: '0x2Ec6de17c7D14c76485e3bfc4BB5E653b657ADcc',
    transaction: '0xc1e1eb6f8a984c3f5606fa8c71738a791a9816a117ec1852cf3834245b5c6c66',
    network: 'eip155:8453',
  })).toString('base64');
}

function wallet(overrides: Record<string, unknown> = {}) {
  return {
    account: { address: '0x2Ec6de17c7D14c76485e3bfc4BB5E653b657ADcc' },
    chain: { id: 8453 },
    signTypedData: async () => `0x${'11'.repeat(65)}`,
    ...overrides,
  } as any;
}

test('runX402PaidFetch handles 402 -> wallet signature -> retry -> 200', async () => {
  const states: string[] = [];
  const seenHeaders: string[] = [];
  let calls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    calls += 1;
    const request = input instanceof Request ? input : new Request(input);
    seenHeaders.push(Array.from(request.headers.keys()).join(','));
    if (calls === 1) {
      return paymentRequiredResponse();
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'payment-response': paymentResponseHeader(),
      },
    });
  };

  const result = await runX402PaidFetch({
    route: '/api/x402/smoke-paid',
    walletClient: wallet(),
    fetchImpl,
    onState: (state) => states.push(state),
  });

  assert.strictEqual(calls, 2);
  assert.strictEqual(result.paid, true);
  assert.strictEqual((result.body as { ok: boolean }).ok, true);
  assert.strictEqual(result.receipt?.success, true);
  assert.strictEqual(result.receipt?.transaction, '0xc1e1eb6f8a984c3f5606fa8c71738a791a9816a117ec1852cf3834245b5c6c66');
  assert.ok(states.includes('preparing_payment'));
  assert.ok(states.includes('awaiting_wallet_confirmation'));
  assert.ok(states.includes('settling_payment'));
  assert.ok(states.includes('running_action'));
  assert.strictEqual(states.at(-1), 'succeeded');
  assert.ok(seenHeaders[1].includes('payment-signature') || seenHeaders[1].includes('x-payment'));
});

test('runX402PaidFetch maps wallet rejection to rejected state', async () => {
  const fetchImpl: typeof fetch = async () => paymentRequiredResponse();

  await assert.rejects(
    runX402PaidFetch({
      route: '/api/x402/smoke-paid',
      walletClient: wallet({
        signTypedData: async () => {
          throw new Error('User rejected the request');
        },
      }),
      fetchImpl,
    }),
    (error: any) => error.state === 'rejected' && error.message === 'Payment rejected',
  );
});

test('runX402PaidFetch maps missing wallet to unsupported_wallet', async () => {
  assert.strictEqual(hasSupportedWalletClient(null), false);
  await assert.rejects(
    runX402PaidFetch({ route: '/api/x402/smoke-paid', walletClient: null }),
    (error: any) => error.state === 'unsupported_wallet' && error.message === 'Connect wallet first',
  );
});

test('runX402PaidFetch treats 503 as settlement_failed without crashing', async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ error: 'x402_facilitator_unavailable' }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });

  await assert.rejects(
    runX402PaidFetch({ route: '/api/x402/smoke-paid', walletClient: wallet(), fetchImpl }),
    (error: any) => error.state === 'settlement_failed' && error.status === 503,
  );
});

test('decodeX402PaymentResponseHeader returns null for missing or malformed header', () => {
  assert.strictEqual(decodeX402PaymentResponseHeader(null), null);
  assert.strictEqual(decodeX402PaymentResponseHeader('not-base64-json'), null);
  assert.strictEqual(decodeX402PaymentResponseHeader(paymentResponseHeader())?.network, 'eip155:8453');
});

test('paid button state copy is stable', () => {
  assert.strictEqual(paidActionButtonLabel('idle', '0.001 USDC'), 'Pay 0.001 USDC & Run');
  assert.strictEqual(paidActionButtonLabel('awaiting_wallet_confirmation', '0.001 USDC'), 'Confirm in Base Account');
  assert.strictEqual(paidActionButtonLabel('succeeded', '0.001 USDC'), 'Paid & completed');
  assert.strictEqual(paidActionCopy('succeeded'), 'Receipt saved to Fuel history.');
});

test('paid client source does not ask for or persist raw signing secrets', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/paidFetch.ts'), 'utf8');
  const forbidden = [
    'X402_PAYER_PRIVATE_KEY',
    'localStorage',
    'sessionStorage',
    'seed phrase',
  ];
  for (const token of forbidden) {
    assert.strictEqual(source.includes(token), false, `forbidden token found: ${token}`);
  }
});

test('mapPaidActionError keeps unknown client errors fail-closed', () => {
  const mapped = mapPaidActionError(new Error('connector cannot signTypedData'));
  assert.strictEqual(mapped.state, 'unsupported_wallet');
});

test('runX402PaidFetch treats HTTP 200 with settled body as paid even if header missing', async () => {
  let step = 0;
  const mockFetch = async () => {
    step++;
    if (step === 1) {
      return paymentRequiredResponse();
    }
    return new Response(
      JSON.stringify({
        ok: true,
        settlement: 'settled',
        payer: '0x2Ec6de17c7D14c76485e3bfc4BB5E653b657ADcc',
        txHash: '0xc1e1eb6f8a984c3f5606fa8c71738a791a9816a117ec1852cf3834245b5c6c66',
        network: 'eip155:8453',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };

  const result = await runX402PaidFetch({
    route: '/api/x402/smoke-paid',
    walletClient: wallet() as never,
    fetchImpl: mockFetch as never,
  });

  assert.strictEqual(result.paid, true);
  assert.strictEqual(result.receipt?.txHash, '0xc1e1eb6f8a984c3f5606fa8c71738a791a9816a117ec1852cf3834245b5c6c66');
});

// T59: PaidFetchOptions.init lets a caller POST a JSON body through the SAME
// 402 -> sign -> retry flow (decision 10). Every prior GET caller is
// unaffected — `init` is optional and merges under the runId/Accept headers.
test('runX402PaidFetch forwards init (method/body) through both the 402 probe and the paid retry', async () => {
  const seenRequests: { method: string; body: string | null; hasIdempotencyHeader: boolean }[] = [];
  let calls = 0;
  const fetchImpl: typeof fetch = async (input, reqInit) => {
    calls += 1;
    const request = input instanceof Request ? input : new Request(input, reqInit);
    seenRequests.push({
      method: request.method,
      body: reqInit?.body ? String(reqInit.body) : null,
      hasIdempotencyHeader: request.headers.has('x-idempotency-key'),
    });
    if (calls === 1) {
      return paymentRequiredResponse();
    }
    return new Response(JSON.stringify({ ok: true, outcome: 'simulated' }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'payment-response': paymentResponseHeader(),
      },
    });
  };

  const requestBody = JSON.stringify({ routeRunId: 'run-1', walletAddress: wallet().account.address, idempotencyKey: 'idem-1' });
  const result = await runX402PaidFetch({
    route: '/api/route-intelligence/blueprints/b1/simulate',
    walletClient: wallet(),
    fetchImpl,
    runId: 'idem-1',
    init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: requestBody },
  });

  assert.strictEqual(calls, 2);
  assert.strictEqual(result.paid, true);
  assert.strictEqual(seenRequests.every((entry) => entry.method === 'POST'), true);
  assert.strictEqual(seenRequests[1]?.hasIdempotencyHeader, true);
});

// T67X-A3: the compatibility shim is gone, and this is what keeps it gone.
// It used to intercept every 402, add `resource` and `scheme: 'exact'` to the
// body, and re-encode the PAYMENT-REQUIRED header from the patched result — so
// the client was paying against requirements the CLIENT had assembled.
//
// It was also never needed: the v2 client reads the header, which the resource
// server has always set correctly. `lib/x402-gateway/src/conformance.test.ts`
// drives the real middleware with the unmodified official client and asserts
// the envelope directly. If Miorail ever emits a 402 the client cannot consume,
// that test is the one that fails — and the fix belongs in the server response,
// not here.
test('the client never repairs a 402', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/paidFetch.ts'), 'utf8');
  for (const banned of [
    'encodePaymentRequiredHeader',
    'normalizeX402PaymentRequired',
    'createX402CompatibilityFetch',
  ]) {
    assert.strictEqual(
      source.includes(banned),
      false,
      `the x402 client must not reconstruct the payment envelope (${banned})`,
    );
  }
});
