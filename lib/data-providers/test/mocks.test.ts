import test from 'node:test';
import assert from 'node:assert';
import { MockMoralisProvider, MockCoinGeckoProvider, MockDeFiLlamaProvider, MockGoPlusProvider } from '../src/mocks.js';

test('MockMoralisProvider', async () => {
  const provider = new MockMoralisProvider();
  const balances = await provider.getWalletTokenBalances('0x0');
  assert.strictEqual(balances.length, 1);
  assert.strictEqual(balances[0].symbol, 'MTK');
});

test('MockCoinGeckoProvider', async () => {
  const provider = new MockCoinGeckoProvider();
  const price = await provider.getSimplePrice(['ethereum'], ['usd']);
  assert.strictEqual(price['ethereum']['usd'], 100.50);
});

test('MockDeFiLlamaProvider', async () => {
  const provider = new MockDeFiLlamaProvider();
  const tvl = await provider.getProtocolTvl('uniswap');
  assert.strictEqual(tvl, 50000000);
});

test('MockGoPlusProvider', async () => {
  const provider = new MockGoPlusProvider();
  const security = await provider.tokenSecurityCheck(1, '0x0');
  assert.strictEqual(security.is_honeypot, "0");
});
