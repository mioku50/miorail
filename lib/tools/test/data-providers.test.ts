import test from 'node:test';
import assert from 'node:assert';
import { MockMoralisProvider, MockCoinGeckoProvider, MockDeFiLlamaProvider, MockGoPlusProvider } from '../src/data-providers.js';

test('MockMoralisProvider', async (_t) => {
  const provider = new MockMoralisProvider();
  const balances = await provider.getWalletTokenBalances('0x123');
  assert.strictEqual(balances.length, 2);
  assert.strictEqual(balances[0].token, 'ETH');
});

test('MockCoinGeckoProvider', async (_t) => {
  const provider = new MockCoinGeckoProvider();
  const price = await provider.getSimplePrice('ethereum');
  assert.strictEqual(price.ethereum.usd, 3500);
});

test('MockDeFiLlamaProvider', async (_t) => {
  const provider = new MockDeFiLlamaProvider();
  const tvl = await provider.getProtocolTvl('uniswap-v3');
  assert.strictEqual(tvl.tvl, 5000000000);
});

test('MockGoPlusProvider', async (_t) => {
  const provider = new MockGoPlusProvider();
  const security = await provider.getTokenSecurity('0xToken', '1');
  assert.strictEqual(security.is_honeypot, "0");
});
