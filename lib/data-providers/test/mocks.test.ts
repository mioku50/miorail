import { test, describe } from 'node:test';
import assert from 'node:assert';
import { MockMoralisProvider, MockCoinGeckoProvider, MockDeFiLlamaProvider, MockGoPlusProvider } from '../src/mocks.js';
import type { MoralisProvider, CoinGeckoProvider, DeFiLlamaProvider, GoPlusProvider } from '../src/interfaces.js';

describe('Mock Providers', () => {
  test('MockMoralisProvider', async () => {
    const provider: MoralisProvider = new MockMoralisProvider();
    const balances = await provider.getWalletTokenBalances('0x0');
    assert.strictEqual(balances.length, 1);
    assert.strictEqual(balances[0].symbol, 'MTK');
    assert.strictEqual(balances[0].tokenAddress, '0x123');
    assert.strictEqual(balances[0].balance, '1000000000000000000');
    assert.strictEqual(balances[0].decimals, 18);

    const altBalances = await provider.getWalletTokenBalances('0xdeadbeef');
    assert.deepStrictEqual(altBalances, balances, 'Should accept different wallet address inputs without throwing and return deterministic token balances');
  });

  test('MockCoinGeckoProvider', async () => {
    const provider: CoinGeckoProvider = new MockCoinGeckoProvider();
    const price = await provider.getSimplePrice(['ethereum'], ['usd']);
    assert.strictEqual(price['ethereum']['usd'], 100.50);

    const multiPrice = await provider.getSimplePrice(['ethereum', 'bitcoin'], ['usd', 'eur']);
    assert.strictEqual(multiPrice['ethereum']['usd'], 100.50);
    assert.strictEqual(multiPrice['ethereum']['eur'], 100.50);
    assert.strictEqual(multiPrice['bitcoin']['usd'], 100.50);
    assert.strictEqual(multiPrice['bitcoin']['eur'], 100.50);

    const emptyIdsPrice = await provider.getSimplePrice([], ['usd']);
    assert.deepStrictEqual(emptyIdsPrice, {}, 'Should handle empty id arrays gracefully');

    const emptyCurrenciesPrice = await provider.getSimplePrice(['ethereum'], []);
    assert.deepStrictEqual(emptyCurrenciesPrice['ethereum'], {}, 'Should handle empty currency arrays gracefully');
  });

  test('MockDeFiLlamaProvider', async () => {
    const provider: DeFiLlamaProvider = new MockDeFiLlamaProvider();
    const tvl = await provider.getProtocolTvl('uniswap');
    assert.strictEqual(tvl, 50000000);

    const altTvl = await provider.getProtocolTvl('aave');
    assert.strictEqual(altTvl, 50000000, 'Should accept different protocol names without throwing and return deterministic numeric TVL');
  });

  test('MockGoPlusProvider', async () => {
    const provider: GoPlusProvider = new MockGoPlusProvider();
    const security = await provider.tokenSecurityCheck(1, '0x0');
    assert.strictEqual(security.is_honeypot, "0");
    assert.strictEqual(security.is_open_source, "1");
    assert.strictEqual(security.is_proxy, "0");
    assert.strictEqual(security.is_mintable, "0");

    const altSecurity = await provider.tokenSecurityCheck(8453, '0x036cbd53842c5426634e7929541ec2318f3dcf7e');
    assert.deepStrictEqual(altSecurity, security, 'Should accept different chainId/tokenAddress inputs without throwing and return deterministic security flags');
  });

  test('MockTokenBalancesProvider', async () => {
    const provider = new (await import('../src/mocks.js')).MockTokenBalancesProvider();
    const balances = await provider.getTokenBalances({ address: '0x123', chainId: 8453 });
    assert.strictEqual(balances.length, 1);
    assert.strictEqual(balances[0].symbol, 'USDC');
  });
});

