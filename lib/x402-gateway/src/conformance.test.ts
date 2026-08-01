import assert from 'node:assert/strict';
import { test, describe, after, before } from 'node:test';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

import express from 'express';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';
import { x402Client } from '@x402/fetch';
import { wrapFetchWithPayment } from '@x402/fetch';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';

import {
  clearX402FacilitatorStatusForTests,
  createX402MiddlewareFromEnv,
  x402ConfigFromEnv,
} from './index.js';

// ---------------------------------------------------------------------------
// T67X-A2 — conformance against the OFFICIAL x402 client.
//
// The point of this file is what it does NOT do. The client below is the
// unmodified `wrapFetchWithPayment` over a plain `fetch`. There is no
// compatibility wrapper, no envelope repair, no hand-set PAYMENT-REQUIRED
// header. If Miorail's 402 is not something the official client can consume as
// it stands, this test fails — and the fix belongs in the server response.
//
// Why that rule matters: a client that repairs the server's envelope pays
// against requirements the CLIENT assembled. `scheme: 'exact'` added on the way
// past is the client asserting which settlement scheme it is about to be
// charged under. That assertion has to come from the server.
//
// The facilitator here is a fake, and deliberately a shallow one: it approves
// whatever it is given. This test is about the HTTP contract — 402, header,
// decode, sign, retry, settle, PAYMENT-RESPONSE — not about whether a signature
// is valid. Signature validity is the facilitator's job in production and
// pretending to check it here would only test the fake.
// ---------------------------------------------------------------------------

const PAY_TO = '0x8e525BfCe1eF40Aa8075ef64E45421b5855C8909';
const NETWORK = 'eip155:8453';
// A well-known test key. It signs nothing that exists: the fake facilitator
// never submits, and no mainnet call is made anywhere in this file.
const BUYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;

interface FakeFacilitator {
  url: string;
  close(): Promise<void>;
  settleCalls: number;
  verifyCalls: number;
}

async function startFakeFacilitator(): Promise<FakeFacilitator> {
  const state = { settleCalls: 0, verifyCalls: 0 };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = (req.url || '').split('?')[0];
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (path?.endsWith('/supported')) {
        return json(200, { kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK }] });
      }
      if (path?.endsWith('/verify')) {
        state.verifyCalls += 1;
        return json(200, { isValid: true });
      }
      if (path?.endsWith('/settle')) {
        state.settleCalls += 1;
        const payload = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        return json(200, {
          success: true,
          transaction: `0x${'ab'.repeat(32)}`,
          network: payload?.paymentPayload?.accepted?.network || NETWORK,
          payer: privateKeyToAccount(BUYER_KEY).address,
        });
      }
      return json(404, { error: 'not_found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    get settleCalls() {
      return state.settleCalls;
    },
    get verifyCalls() {
      return state.verifyCalls;
    },
  };
}

async function startMiorail(facilitatorUrl: string): Promise<{ url: string; close(): Promise<void> }> {
  const env: NodeJS.ProcessEnv = {
    X402_FACILITATOR_URL: facilitatorUrl,
    X402_PAYTO_ADDRESS: PAY_TO,
    X402_NETWORK: NETWORK,
    X402_AMOUNT_ATOMIC_USDC: '1000',
    X402_FACILITATOR_AUTH_TOKEN: 'test-token',
    BASE_BUILDER_CODE: 'miorail',
  };
  const config = x402ConfigFromEnv(env);
  assert.equal(config.configured, true, `gateway must be configured: ${config.missingConfig.join(', ')}`);
  assert.equal(config.settleReady, true, `gateway must be settle-ready: ${config.settleBlockedReason}`);

  const app = express();
  app.get(
    '/paid',
    // The production entry point, not a hand-assembled one. A conformance test
    // against a middleware nobody mounts proves the wrong thing.
    createX402MiddlewareFromEnv({ routePath: '/paid', serviceName: 'Miorail' }, env),
    (_req, res) => {
      res.status(200).json({ ok: true, data: 'protected' });
    },
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function officialClient() {
  const client = new x402Client();
  registerExactEvmScheme(client, {
    signer: privateKeyToAccount(BUYER_KEY) as never,
    networks: [NETWORK],
  });
  return client;
}

// This package compiles to CJS, so the servers start in a hook rather than at
// top level.
let facilitator: FakeFacilitator;
let miorail: { url: string; close(): Promise<void> };

before(async () => {
  // The facilitator health cache is module-level and keyed by URL; a stale
  // entry from another suite would decide this one.
  clearX402FacilitatorStatusForTests();
  facilitator = await startFakeFacilitator();
  miorail = await startMiorail(facilitator.url);
});

after(async () => {
  await miorail?.close();
  await facilitator?.close();
});

describe('Miorail speaks x402 to the official client', () => {
  test('the unpaid 402 decodes with the official decoder, unmodified', async () => {
    const response = await fetch(`${miorail.url}/paid`);
    assert.equal(response.status, 402);

    const header = response.headers.get('PAYMENT-REQUIRED');
    assert.ok(header, 'the 402 must carry a PAYMENT-REQUIRED header; the v2 client reads nothing else');

    // The official decoder, not a local parse. This is the assertion the shim
    // used to make unnecessary by rewriting the header itself.
    const paymentRequired = decodePaymentRequiredHeader(header);
    assert.equal(paymentRequired.x402Version, 2);
    assert.ok(paymentRequired.resource?.url, 'resource.url is required by the v2 envelope');
    assert.equal(paymentRequired.accepts.length > 0, true);

    const accept = paymentRequired.accepts[0]!;
    // The server names the settlement scheme. A client that supplies it is
    // choosing what it is charged under.
    assert.equal(accept.scheme, 'exact');
    assert.equal(accept.network, NETWORK);
    assert.equal(accept.payTo, PAY_TO);
    assert.equal(accept.amount, '1000');
    assert.equal(typeof accept.maxTimeoutSeconds, 'number');
    // EIP-712 domain for the USDC permit — without it the buyer signs against
    // a domain of its own invention and the facilitator rejects the signature.
    assert.equal((accept.extra as { name?: string })?.name, 'USD Coin');
    assert.equal((accept.extra as { version?: string })?.version, '2');
  });

  test('402 → sign → retry → settle → PAYMENT-RESPONSE, over a plain fetch', async () => {
    const attempts: Array<{ hasSignature: boolean }> = [];
    const instrumentedFetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input as never, init);
      attempts.push({
        hasSignature:
          request.headers.has('PAYMENT-SIGNATURE') || request.headers.has('X-PAYMENT'),
      });
      return globalThis.fetch(request);
    };

    // No compatibility wrapper anywhere in this chain.
    const paidFetch = wrapFetchWithPayment(instrumentedFetch, officialClient());
    const response = await paidFetch(`${miorail.url}/paid`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, data: 'protected' });

    assert.equal(attempts.length, 2, 'exactly one unpaid attempt and one paid retry');
    assert.equal(attempts[0]!.hasSignature, false);
    assert.equal(attempts[1]!.hasSignature, true);

    const settled = decodePaymentResponseHeader(response.headers.get('PAYMENT-RESPONSE')!);
    assert.equal(settled.success, true);
    assert.equal(settled.transaction, `0x${'ab'.repeat(32)}`);

    assert.equal(facilitator.verifyCalls > 0, true, 'the resource server must verify before serving');
    assert.equal(facilitator.settleCalls, 1, 'settlement happens once');
  });

  test('a second paid call settles again rather than replaying the first', async () => {
    const before = facilitator.settleCalls;
    const paidFetch = wrapFetchWithPayment(globalThis.fetch, officialClient());
    const response = await paidFetch(`${miorail.url}/paid`);
    assert.equal(response.status, 200);
    assert.equal(facilitator.settleCalls, before + 1);
  });
});

// T67X-A3 — the counterpart assertion, that no client rebuilds this envelope,
// lives with the client it is about:
// `lib/x402-actions/test/paidFetch.test.ts` → "the client never repairs a 402".
