import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import request from 'supertest';
import { encodeFunctionData, parseAbi, type Hex } from 'viem';

import { app } from '../app.js';
import { SPONSORED_GAS_ENTRY_POINT_V1, sponsorshipKeyV1, type SponsoredCallV1 } from '../lib/sponsoredGas.js';
import {
  approvedStockSponsorshipV1,
  offerSponsorshipV1,
  sponsoredGasConfiguredV1,
  sponsoredGasRouter,
  sponsoredGasRuntime,
  sponsorshipLedgerV1,
} from './sponsoredGas.js';

// ---------------------------------------------------------------------------
// /api/paymaster, end to end against a stand-in for Coinbase's endpoint.
// ---------------------------------------------------------------------------

const WALLET = '0xf7dca789b08ed2f7995d9bc22c500a8ca715d0a8';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const KYBER = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5';
const UPSTREAM = 'https://api.developer.coinbase.com/rpc/v1/base/TESTKEY123';
const NOW = new Date('2026-09-23T10:00:00.000Z');

const erc20 = parseAbi(['function approve(address spender, uint256 amount)']);
const smartWallet = parseAbi(['function executeBatch((address target, uint256 value, bytes data)[] calls)']);

const CALLS: SponsoredCallV1[] = [
  { to: USDC, value: '0x0', data: encodeFunctionData({ abi: erc20, functionName: 'approve', args: [KYBER, 10_000_000n] }) },
  { to: KYBER, value: '0x0', data: '0xe21fd0e9deadbeef' },
];

function callData(calls: readonly SponsoredCallV1[]): Hex {
  return encodeFunctionData({
    abi: smartWallet,
    functionName: 'executeBatch',
    args: [calls.map((call) => ({ target: call.to as Hex, value: BigInt(call.value as string), data: call.data as Hex }))],
  });
}

function stubV1(t: test.TestContext, over: Partial<typeof sponsoredGasRuntime> = {}) {
  const saved = { ...sponsoredGasRuntime };
  const forwarded: { url: string; body: { method: string; params: unknown[] } }[] = [];
  Object.assign(sponsoredGasRuntime, {
    upstreamUrl: () => UPSTREAM,
    key: () => sponsorshipKeyV1({ SESSION_SECRET: 'route-test-secret' } as NodeJS.ProcessEnv),
    dailyLimit: () => 3,
    origin: () => 'https://miorail.xyz',
    now: () => NOW,
    forward: async (url: string, body: unknown) => {
      forwarded.push({ url, body: body as { method: string; params: unknown[] } });
      return { jsonrpc: '2.0', id: 1, result: { paymasterAndData: '0x2faeb0760d4230ef2ac21496bb4f0b47d634fd4c' } };
    },
    ...over,
  });
  sponsorshipLedgerV1.clear();
  t.after(() => {
    Object.assign(sponsoredGasRuntime, saved);
    sponsorshipLedgerV1.clear();
  });
  return forwarded;
}

function routerApp() {
  const local = express();
  local.use('/api/paymaster', sponsoredGasRouter);
  return local;
}

function rpc(method: string, context: unknown, over: Partial<{ nonce: string; sender: string; calls: SponsoredCallV1[] }> = {}) {
  return {
    jsonrpc: '2.0',
    id: 7,
    method,
    params: [
      { sender: over.sender ?? WALLET, nonce: over.nonce ?? '0x1', callData: callData(over.calls ?? CALLS), initCode: '0x' },
      SPONSORED_GAS_ENTRY_POINT_V1,
      '0x2105',
      context,
    ],
  };
}

test('an approved operation is forwarded, and the wallet gets the paymaster’s answer', async (t) => {
  const forwarded = stubV1(t);
  const offer = offerSponsorshipV1({ wallet: WALLET, blueprintId: 'bp-1', calls: CALLS })!;
  assert.equal(offer.paymasterUrl, 'https://miorail.xyz/api/paymaster', 'the wallet is sent to us, never upstream');
  const response = await request(routerApp())
    .post('/api/paymaster')
    .send(rpc('pm_getPaymasterData', offer.context))
    .expect(200);
  assert.deepEqual(response.body, {
    jsonrpc: '2.0',
    id: 7,
    result: { paymasterAndData: '0x2faeb0760d4230ef2ac21496bb4f0b47d634fd4c' },
  });
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0]!.url, UPSTREAM);
  assert.equal(forwarded[0]!.body.method, 'pm_getPaymasterData');
  // Our token stays here; the upstream gets an empty context.
  assert.deepEqual(forwarded[0]!.body.params[3], {});
});

test('a refusal never reaches the paymaster, and never names its URL', async (t) => {
  const forwarded = stubV1(t);
  const response = await request(routerApp())
    .post('/api/paymaster')
    .send(rpc('pm_getPaymasterData', {}))
    .expect(200);
  assert.equal(response.body.error.data.reason, 'no_sponsorship');
  assert.equal(forwarded.length, 0);
  assert.doesNotMatch(JSON.stringify(response.body), /TESTKEY123|developer\.coinbase/);
});

test('another wallet riding an approval is refused', async (t) => {
  const forwarded = stubV1(t);
  const offer = offerSponsorshipV1({ wallet: WALLET, blueprintId: 'bp-1', calls: CALLS })!;
  const response = await request(routerApp())
    .post('/api/paymaster')
    .send(rpc('pm_getPaymasterData', offer.context, { sender: '0x2222222222222222222222222222222222222222' }))
    .expect(200);
  assert.equal(response.body.error.data.reason, 'wrong_sender');
  assert.equal(forwarded.length, 0);
});

test('a stub is an estimate; only the final data counts against the day', async (t) => {
  stubV1(t, { dailyLimit: () => 1 });
  const offer = offerSponsorshipV1({ wallet: WALLET, blueprintId: 'bp-1', calls: CALLS })!;
  for (let i = 0; i < 3; i += 1) {
    await request(routerApp()).post('/api/paymaster').send(rpc('pm_getPaymasterStubData', offer.context)).expect(200);
  }
  const final = await request(routerApp()).post('/api/paymaster').send(rpc('pm_getPaymasterData', offer.context)).expect(200);
  assert.ok(final.body.result, 'three estimates did not spend the one sponsored operation');
  // The wallet asking again for the same operation is a retry, not a second one.
  const retry = await request(routerApp()).post('/api/paymaster').send(rpc('pm_getPaymasterData', offer.context)).expect(200);
  assert.ok(retry.body.result);
  const next = await request(routerApp())
    .post('/api/paymaster')
    .send(rpc('pm_getPaymasterData', offer.context, { nonce: '0x2' }))
    .expect(200);
  assert.equal(next.body.error.data.reason, 'daily_limit_reached');
  // And the next approval is not offered sponsorship it could not get.
  assert.equal(offerSponsorshipV1({ wallet: WALLET, blueprintId: 'bp-2', calls: CALLS }), null);
});

test('an upstream refusal is not counted, and its words stay in our log', async (t) => {
  stubV1(t, {
    dailyLimit: () => 1,
    forward: async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32604, message: 'payment method not found' } }),
  });
  const offer = offerSponsorshipV1({ wallet: WALLET, blueprintId: 'bp-1', calls: CALLS })!;
  const response = await request(routerApp()).post('/api/paymaster').send(rpc('pm_getPaymasterData', offer.context)).expect(200);
  assert.equal(response.body.error.data.reason, 'upstream_declined');
  assert.doesNotMatch(JSON.stringify(response.body), /payment method/);
  assert.equal(sponsorshipLedgerV1.allows(WALLET, '0x9'), true, 'a refused operation spent nothing');
});

test('an upstream that does not answer is our failure, said plainly', async (t) => {
  stubV1(t, {
    forward: async () => {
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    },
  });
  const offer = offerSponsorshipV1({ wallet: WALLET, blueprintId: 'bp-1', calls: CALLS })!;
  const response = await request(routerApp()).post('/api/paymaster').send(rpc('pm_getPaymasterData', offer.context)).expect(200);
  assert.equal(response.body.error.data.reason, 'upstream_unavailable');
});

test('unconfigured means no offer and a plain refusal, not a broken endpoint', async (t) => {
  stubV1(t, { upstreamUrl: () => null });
  assert.equal(sponsoredGasConfiguredV1(), false);
  assert.equal(offerSponsorshipV1({ wallet: WALLET, blueprintId: 'bp-1', calls: CALLS }), null);
  const response = await request(routerApp()).post('/api/paymaster').send(rpc('pm_getPaymasterData', {})).expect(200);
  assert.equal(response.body.error.data.reason, 'not_configured');
});

test('a limit of zero switches sponsorship off', async (t) => {
  stubV1(t, { dailyLimit: () => 0 });
  assert.equal(sponsoredGasConfiguredV1(), false);
  assert.equal(offerSponsorshipV1({ wallet: WALLET, blueprintId: 'bp-1', calls: CALLS }), null);
});

test('something that is not JSON-RPC gets a JSON-RPC error', async (t) => {
  stubV1(t);
  const response = await request(routerApp()).post('/api/paymaster').send({ hello: 'world' }).expect(200);
  assert.equal(response.body.error.code, -32600);
});

test('the wallet’s preflight is answered through the real app, past its CORS', async (t) => {
  stubV1(t);
  // The app's own CORS allows only its configured origins and would end this
  // preflight with no allowed origin. The wallet asks from its own.
  const response = await request(app)
    .options('/api/paymaster')
    .set('Origin', 'https://keys.coinbase.com')
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', 'content-type')
    .expect(204);
  assert.equal(response.headers['access-control-allow-origin'], '*');
  assert.match(String(response.headers['access-control-allow-headers']), /Content-Type/i);
  assert.equal(response.headers['access-control-allow-credentials'], undefined);
});

test('the real app serves the paymaster without a session', async (t) => {
  stubV1(t);
  const offer = offerSponsorshipV1({ wallet: WALLET, blueprintId: 'bp-1', calls: CALLS })!;
  const response = await request(app)
    .post('/api/paymaster')
    .set('Origin', 'https://keys.coinbase.com')
    .send(rpc('pm_getPaymasterStubData', offer.context))
    .expect(200);
  assert.ok(response.body.result);
  assert.equal(response.headers['access-control-allow-origin'], '*');
  assert.equal(response.headers['set-cookie'], undefined, 'no session is started for a wallet');
});

test('only a swap that touches a reviewed stock is offered sponsored gas', async (t) => {
  stubV1(t);
  const NVDA_B20 = '0xb20000000000000000000078ee7ce2fe4908108c';
  const MEME = '0x3333333333333333333333333333333333333333';
  const reviewed = async (address: string) => address === NVDA_B20;
  const asked = (assets: (string | null)[]) =>
    approvedStockSponsorshipV1({ assets, isReviewedStock: reviewed, wallet: WALLET, blueprintId: 'bp', calls: CALLS });
  assert.ok(await asked([USDC, NVDA_B20]), 'buying a reviewed stock');
  assert.ok(await asked([NVDA_B20, USDC]), 'selling one');
  assert.equal(await asked([USDC, MEME]), null, 'a token outside the corpus is not a stock');
  assert.equal(await asked([null, USDC]), null, 'ETH and USDC alone are not a stock');
});

test('nothing is looked up while sponsorship is off', async (t) => {
  stubV1(t, { upstreamUrl: () => null });
  let looked = 0;
  const offer = await approvedStockSponsorshipV1({
    assets: [USDC],
    isReviewedStock: async () => {
      looked += 1;
      return true;
    },
    wallet: WALLET,
    blueprintId: 'bp',
    calls: CALLS,
  });
  assert.equal(offer, null);
  assert.equal(looked, 0);
});

test('the public status says on or off and nothing about the upstream', async (t) => {
  stubV1(t);
  const on = await request(app).get('/api/paymaster/status').expect(200);
  assert.deepEqual(on.body, {
    schemaVersion: 'sponsored-gas-status/v1',
    sponsoredGas: 'on',
    dailyLimitPerWallet: 3,
    scope: 'reviewed_stock_swaps',
    wallets: 'base_account',
  });
  assert.doesNotMatch(JSON.stringify(on.body), /TESTKEY123|coinbase\.com/);
  Object.assign(sponsoredGasRuntime, { upstreamUrl: () => null });
  const off = await request(app).get('/api/paymaster/status').expect(200);
  assert.equal(off.body.sponsoredGas, 'off');
  assert.equal(off.body.dailyLimitPerWallet, null);
});
