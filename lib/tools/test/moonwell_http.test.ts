import assert from 'node:assert/strict';
import test from 'node:test';
import { MoonwellHttpToolProvider } from '../src/moonwell_http.js';

const WALLET = '0x1111111111111111111111111111111111111111';

test('Moonwell provider exposes the six read tools and four prepare tools', async () => {
  const provider = new MoonwellHttpToolProvider(async () => new Response('{}') as any);
  const names = (await provider.listTools()).map((tool) => tool.name);
  assert.deepEqual(names, [
    'moonwell_get_markets',
    'moonwell_get_rates',
    'moonwell_get_positions',
    'moonwell_get_health',
    'moonwell_get_rewards',
    'moonwell_get_token_balance',
    'moonwell_prepare_supply',
    'moonwell_prepare_withdraw',
    'moonwell_prepare_borrow',
    'moonwell_prepare_repay',
  ]);
});

test('Moonwell provider rejects non-Base calls before the network', async () => {
  let called = false;
  const provider = new MoonwellHttpToolProvider(async () => {
    called = true;
    return new Response('{}');
  });
  const result = await provider.callTool('moonwell_get_markets', { chain: 'ethereum' });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content).errorCode, 'moonwell_base_only');
  assert.equal(called, false);
});

test('Moonwell read tool builds the documented URL and returns the payload', async () => {
  let requestedUrl: string | undefined;
  const provider = new MoonwellHttpToolProvider(async (url: unknown) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({ markets: [{ symbol: 'USDC', supplyApy: 4.2 }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const result = await provider.callTool('moonwell_get_markets', { chain: 'base' });
  assert.equal(result.isError, false);
  assert.equal(requestedUrl, 'https://api.moonwell.fi/v1/markets?chain=base');
  assert.deepEqual(JSON.parse(result.content), { markets: [{ symbol: 'USDC', supplyApy: 4.2 }] });
});

test('Moonwell asset-scoped market read uses the reviewed per-asset endpoint', async () => {
  let requestedUrl: string | undefined;
  const provider = new MoonwellHttpToolProvider(async (url: unknown) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({ markets: [{ symbol: 'USDC' }] }), { status: 200 });
  });
  const result = await provider.callTool('moonwell_get_markets', { chain: 'base', asset: 'USDC' });
  assert.equal(result.isError, false);
  assert.equal(requestedUrl, 'https://api.moonwell.fi/v1/markets/USDC?chain=base');
});

test('Moonwell positions/health reads validate the wallet address and build per-address URLs', async () => {
  let requestedUrl: string | undefined;
  const provider = new MoonwellHttpToolProvider(async (url: unknown) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({ healthFactor: 1.8 }), { status: 200 });
  });
  const invalid = await provider.callTool('moonwell_get_health', { chain: 'base', address: 'not-an-address' });
  assert.equal(invalid.isError, true);
  assert.equal(JSON.parse(invalid.content).errorCode, 'moonwell_invalid_wallet_address');

  const result = await provider.callTool('moonwell_get_health', { chain: 'base', address: WALLET });
  assert.equal(result.isError, false);
  assert.equal(requestedUrl, `https://api.moonwell.fi/v1/health/${WALLET}?chain=base`);
});

test('Moonwell prepare tool parses ordered transactions[] out of the documented response shape', async () => {
  let requestedUrl: string | undefined;
  const provider = new MoonwellHttpToolProvider(async (url: unknown) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({
      data: {
        transactions: [
          { step: 'approve', to: '0x2222222222222222222222222222222222222222', data: '0xapprove', value: '0x0', chainId: 8453 },
          { step: 'moonwell-supply', to: '0x3333333333333333333333333333333333333333', data: '0xsupply', value: '0x0', chainId: 8453 },
        ],
      },
    }), { status: 200 });
  });
  const result = await provider.callTool('moonwell_prepare_supply', {
    chain: 'base', asset: 'USDC', amountDecimal: '100', from: WALLET,
  });
  assert.equal(result.isError, false);
  assert.equal(
    requestedUrl,
    `https://api.moonwell.fi/v1/prepare/supply?chain=base&asset=USDC&amountDecimal=100&from=${WALLET}`,
  );
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.transactions.length, 2);
  assert.equal(parsed.transactions[0].step, 'approve');
  assert.equal(parsed.transactions[1].to, '0x3333333333333333333333333333333333333333');
});

test('Moonwell prepare tool rejects a malformed prepare response instead of passing it through', async () => {
  const provider = new MoonwellHttpToolProvider(async () => new Response(JSON.stringify({ data: {} }), { status: 200 }));
  const result = await provider.callTool('moonwell_prepare_borrow', {
    chain: 'base', asset: 'USDC', amountDecimal: '50', from: WALLET,
  });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content).errorCode, 'moonwell_prepare_invalid_response');
});

test('Moonwell prepare tool validates amount and wallet before calling the network', async () => {
  let called = false;
  const provider = new MoonwellHttpToolProvider(async () => {
    called = true;
    return new Response('{}');
  });
  const badAmount = await provider.callTool('moonwell_prepare_repay', {
    chain: 'base', asset: 'USDC', amountDecimal: '-5', from: WALLET,
  });
  assert.equal(badAmount.isError, true);
  assert.equal(JSON.parse(badAmount.content).errorCode, 'moonwell_invalid_amount');
  assert.equal(called, false);
});

test('Moonwell provider surfaces an http error code on a non-ok response', async () => {
  const provider = new MoonwellHttpToolProvider(async () => new Response('nope', { status: 500 }));
  const result = await provider.callTool('moonwell_get_markets', { chain: 'base' });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content).errorCode, 'moonwell_request_failed');
});
