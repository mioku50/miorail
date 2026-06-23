import test from 'node:test';
import assert from 'node:assert';
import { NativeToolProvider } from '../src/native.js';
import { MockCoinGeckoProvider, MockMoralisProvider } from '@mioagent/data-providers';

test('NativeToolProvider', async (t) => {
  const provider = new NativeToolProvider(new MockCoinGeckoProvider(), new MockMoralisProvider());

  await t.test('listTools returns native tools', async () => {
    const tools = await provider.listTools();
    assert.strictEqual(tools.length, 2);
    assert.strictEqual(tools[0].name, 'get_token_price');
    assert.strictEqual(tools[1].name, 'get_wallet_portfolio');
  });

  await t.test('findTool returns tool definition', () => {
    const tool = provider.findTool('get_token_price');
    assert.ok(tool);
    assert.strictEqual(tool.name, 'get_token_price');

    const notFound = provider.findTool('unknown_tool');
    assert.strictEqual(notFound, undefined);
  });

  await t.test('callTool get_token_price', async () => {
    const result = await provider.callTool('get_token_price', { token: 'ETH' });
    assert.strictEqual(result.isError, false);
    assert.ok(result.content.includes('100.5')); // MockCoinGeckoProvider returns 100.50
  });

  await t.test('callTool get_wallet_portfolio', async () => {
    const result = await provider.callTool('get_wallet_portfolio', { wallet: '0x123' });
    assert.strictEqual(result.isError, false);
    assert.ok(result.content.includes('MTK')); // MockMoralisProvider returns MTK balance
  });

  await t.test('callTool with missing parameters', async () => {
    const result = await provider.callTool('get_token_price', {});
    assert.strictEqual(result.isError, true);
  });

  await t.test('callTool with unknown tool', async () => {
    const result = await provider.callTool('unknown_tool', {});
    assert.strictEqual(result.isError, true);
  });
});
