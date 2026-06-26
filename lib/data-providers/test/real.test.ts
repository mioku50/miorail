import { test, describe, mock } from 'node:test';
import assert from 'node:assert';
import { RealCoinGeckoProvider, RealDeFiLlamaProvider, RealGoPlusProvider, RealMoralisProvider } from '../src/real.js';

describe('Real Providers', () => {
    test('CoinGeckoProvider calls correct endpoint', async () => {
        const mockFetch = mock.fn(async () => {
            return {
                ok: true,
                json: async () => ({
                    ethereum: { usd: 100.5 }
                })
            } as Response;
        });
        global.fetch = mockFetch as unknown as typeof fetch;

        const provider = new RealCoinGeckoProvider();
        const price = await provider.getSimplePrice(['ethereum'], ['usd']);

        assert.deepStrictEqual(price, { ethereum: { usd: 100.5 } });
        assert.strictEqual(mockFetch.mock.calls.length, 1);
        assert.strictEqual(mockFetch.mock.calls[0].arguments[0], 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
        mock.restoreAll();
    });

    test('DeFiLlamaProvider calls correct endpoint', async () => {
        const mockFetch = mock.fn(async () => {
            return {
                ok: true,
                json: async () => 50000000
            } as Response;
        });
        global.fetch = mockFetch as unknown as typeof fetch;

        const provider = new RealDeFiLlamaProvider();
        const tvl = await provider.getProtocolTvl('uniswap');

        assert.strictEqual(tvl, 50000000);
        assert.strictEqual(mockFetch.mock.calls.length, 1);
        assert.strictEqual(mockFetch.mock.calls[0].arguments[0], 'https://api.llama.fi/tvl/uniswap');
        mock.restoreAll();
    });

    test('GoPlusProvider calls correct endpoint', async () => {
        const mockFetch = mock.fn(async () => {
            return {
                ok: true,
                json: async () => ({
                    result: {
                        '0xdac17f958d2ee523a2206206994597c13d831ec7': { is_honeypot: '0' }
                    }
                })
            } as Response;
        });
        global.fetch = mockFetch as unknown as typeof fetch;

        const provider = new RealGoPlusProvider();
        const security = await provider.tokenSecurityCheck(1, '0xdAC17F958D2ee523a2206206994597C13D831ec7');

        assert.deepStrictEqual(security, { is_honeypot: '0' });
        assert.strictEqual(mockFetch.mock.calls.length, 1);
        assert.strictEqual(mockFetch.mock.calls[0].arguments[0], 'https://api.gopluslabs.io/api/v1/token_security/1?contract_addresses=0xdAC17F958D2ee523a2206206994597C13D831ec7');
        mock.restoreAll();
    });

    test('MoralisProvider calls correct endpoint', async () => {
        const mockFetch = mock.fn(async () => {
            return {
                ok: true,
                json: async () => ([{
                    token_address: '0x123',
                    balance: '1000',
                    decimals: 18,
                    symbol: 'MTK'
                }])
            } as Response;
        });
        global.fetch = mockFetch as unknown as typeof fetch;

        const provider = new RealMoralisProvider('fake-key');
        const balances = await provider.getWalletTokenBalances('0xabc');

        assert.deepStrictEqual(balances, [{
            tokenAddress: '0x123',
            balance: '1000',
            decimals: 18,
            symbol: 'MTK'
        }]);
        assert.strictEqual(mockFetch.mock.calls.length, 1);
        assert.strictEqual(mockFetch.mock.calls[0].arguments[0], 'https://deep-index.moralis.io/api/v2.2/0xabc/erc20?chain=base');
        assert.strictEqual((mockFetch.mock.calls[0].arguments[1] as unknown as typeof fetch).headers['X-API-Key'], 'fake-key');
        mock.restoreAll();
    });
});
