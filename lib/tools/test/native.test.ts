import test from 'node:test';
import assert from 'node:assert';
import { NativeToolProvider } from '../src/native.js';
import { MockCoinGeckoProvider, MockMoralisProvider } from '@mioagent/data-providers/testing';

test('NativeToolProvider lists native tools', async () => {
  const provider = new NativeToolProvider(
    new MockCoinGeckoProvider(),
    new MockMoralisProvider(),
  );

  const tools = await provider.listTools();

  assert.ok(tools.find((tool) => tool.name === 'get_token_price'));
  assert.ok(tools.find((tool) => tool.name === 'get_wallet_portfolio'));
});

test('NativeToolProvider finds a tool by name', () => {
  const provider = new NativeToolProvider(
    new MockCoinGeckoProvider(),
    new MockMoralisProvider(),
  );

  const tool = provider.findTool('get_token_price');

  assert.ok(tool);
  assert.strictEqual(tool.name, 'get_token_price');
});

test('NativeToolProvider returns token price', async () => {
  const provider = new NativeToolProvider(
    new MockCoinGeckoProvider(),
    new MockMoralisProvider(),
  );

  const result = await provider.callTool('get_token_price', { token: 'ethereum' });

  assert.strictEqual(result.isError, false);
  const parsed = JSON.parse(result.content);
  assert.strictEqual(parsed.token, 'ethereum');
  assert.strictEqual(typeof parsed.priceUsd, 'number');
});

test('NativeToolProvider returns wallet portfolio', async () => {
  const provider = new NativeToolProvider(
    new MockCoinGeckoProvider(),
    new MockMoralisProvider(),
  );

  const result = await provider.callTool('get_wallet_portfolio', { wallet: '0x123' });

  assert.strictEqual(result.isError, false);
  const parsed = JSON.parse(result.content);
  assert.strictEqual(parsed.wallet, '0x123');
  assert.ok(Array.isArray(parsed.tokens));
});

test('NativeToolProvider handles unknown tool', async () => {
  const provider = new NativeToolProvider(
    new MockCoinGeckoProvider(),
    new MockMoralisProvider(),
  );

  const result = await provider.callTool('unknown_tool', {});

  assert.strictEqual(result.isError, true);
  assert.match(result.content, /Unknown tool/);
});
