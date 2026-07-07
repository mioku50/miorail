import { test, describe, mock } from 'node:test';
import assert from 'node:assert';
import {
  AlchemyTokenBalancesProvider,
  RealCoinGeckoProvider,
  CoinGeckoPriceProvider,
  RealDeFiLlamaProvider,
  RealGoPlusProvider,
  RealMoralisProvider,
  GoPlusTokenSecurityProvider,
  NoneTokenSecurityProvider,
  clearTokenSecurityCacheForTests,
  getTokenSecurityProviderFromEnv,
  mapGoPlusTokenSecurity
} from '../src/real.js';
import { ProviderRateLimitError } from '../src/interfaces.js';

function restoreEnv(name: string, value: string | undefined) {
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
}

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

    test('AlchemyTokenBalancesProvider maps token balances and metadata', async () => {
        const token = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
        const mockFetch = mock.fn(async (_url: string | URL | Request, options?: RequestInit) => {
            const body = JSON.parse(String(options?.body || '{}'));
            if (body.method === 'alchemy_getTokenBalances') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ result: { tokenBalances: [{ contractAddress: token, tokenBalance: '0xe4e1c0' }] } })
                } as Response;
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({ result: { symbol: 'USDC', name: 'USD Coin', decimals: 6, logo: null } })
            } as Response;
        });
        global.fetch = mockFetch as unknown as typeof fetch;

        const provider = new AlchemyTokenBalancesProvider('alchemy-key');
        const balances = await provider.getTokenBalances({ address: '0xabc', chainId: 8453 });

        assert.strictEqual(balances.length, 1);
        assert.strictEqual(balances[0].symbol, 'USDC');
        assert.strictEqual(balances[0].balanceFormatted, '15.0000');
        assert.strictEqual(mockFetch.mock.calls.length, 2);
        mock.restoreAll();
    });

    test('AlchemyTokenBalancesProvider classifies HTTP 429 as rate_limited', async () => {
        const mockFetch = mock.fn(async () => ({
            ok: false,
            status: 429,
            statusText: 'Too Many Requests',
            json: async () => ({ error: { message: 'Your app has been rate-limited due to unusually high global traffic.' } })
        } as Response));
        global.fetch = mockFetch as unknown as typeof fetch;

        const provider = new AlchemyTokenBalancesProvider('alchemy-key');
        await assert.rejects(
            () => provider.getTokenBalances({ address: '0xabc', chainId: 8453 }),
            (err: unknown) => {
                assert.ok(err instanceof ProviderRateLimitError);
                assert.strictEqual((err as ProviderRateLimitError).status, 'rate_limited');
                assert.strictEqual((err as ProviderRateLimitError).budgetExhausted, true);
                assert.strictEqual((err as ProviderRateLimitError).provider, 'alchemy');
                return true;
            }
        );
        mock.restoreAll();
    });

    test('AlchemyTokenBalancesProvider classifies JSON-RPC 429 as rate_limited', async () => {
        const mockFetch = mock.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ error: { code: 429, message: 'rate limited' } })
        } as Response));
        global.fetch = mockFetch as unknown as typeof fetch;

        const provider = new AlchemyTokenBalancesProvider('alchemy-key');
        await assert.rejects(
            () => provider.getTokenBalances({ address: '0xabc', chainId: 8453 }),
            (err: unknown) => {
                assert.ok(err instanceof ProviderRateLimitError);
                assert.strictEqual((err as ProviderRateLimitError).statusCode, 429);
                return true;
            }
        );
        mock.restoreAll();
    });

    test('getTokenBalancesProviderFromEnv defaults to Alchemy and reports missing without config', async () => {
        const { getTokenBalancesProviderFromEnv } = await import('../src/real.js');
        delete process.env.TOKEN_BALANCES_PROVIDER;
        delete process.env.ALCHEMY_API_KEY;
        delete process.env.ALCHEMY_BASE_MAINNET_RPC_URL;
        delete process.env.MORALIS_API_KEY;
        const res = getTokenBalancesProviderFromEnv();
        assert.strictEqual(res.providerName, 'alchemy');
        assert.strictEqual(res.status, 'Token balances provider not configured');
        assert.strictEqual(res.statusCode, 'missing');
    });

    test('getPriceProviderFromEnv defaults to CoinGecko', async () => {
        const { getPriceProviderFromEnv } = await import('../src/real.js');
        delete process.env.PRICE_PROVIDER;
        delete process.env.MORALIS_API_KEY;
        const res = getPriceProviderFromEnv();
        assert.strictEqual(res.providerName, 'coingecko');
        assert.strictEqual(res.status, 'CoinGecko connected');
        assert.strictEqual(res.statusCode, 'connected');
    });

    test('CoinGeckoPriceProvider skips native pseudo-address for token_price calls', async () => {
        const mockFetch = mock.fn(async (url: string | URL | Request) => {
            assert.ok(!String(url).includes('contract_addresses=native'));
            return {
                ok: true,
                json: async () => ({ ethereum: { usd: 3000 } })
            } as Response;
        });
        global.fetch = mockFetch as unknown as typeof fetch;

        const provider = new CoinGeckoPriceProvider();
        const prices = await provider.getTokenPrices({ chainId: 8453, tokens: [{ symbol: 'ETH', address: 'native' }] });

        assert.strictEqual(prices.length, 1);
        assert.strictEqual(prices[0].usdPrice, '3000');
        assert.strictEqual(mockFetch.mock.calls.length, 1);
        assert.ok(String(mockFetch.mock.calls[0].arguments[0]).includes('/simple/price'));
        mock.restoreAll();
    });

    test('getTokenBalancesProviderFromEnv reports disabled when TOKEN_BALANCES_PROVIDER=none (explicit)', async () => {
        const { getTokenBalancesProviderFromEnv } = await import('../src/real.js');
        process.env.TOKEN_BALANCES_PROVIDER = 'none';
        const res = getTokenBalancesProviderFromEnv();
        assert.strictEqual(res.providerName, 'none');
        assert.strictEqual(res.statusCode, 'disabled');
        delete process.env.TOKEN_BALANCES_PROVIDER;
    });

    test('getTokenBalancesFallbackProviderFromEnv defaults to disabled none', async () => {
        const { getTokenBalancesFallbackProviderFromEnv } = await import('../src/real.js');
        const origFallback = process.env.TOKEN_BALANCES_FALLBACK_PROVIDER;
        const origMoralisKey = process.env.MORALIS_API_KEY;
        delete process.env.TOKEN_BALANCES_FALLBACK_PROVIDER;
        process.env.MORALIS_API_KEY = 'moralis-test-key';

        const res = getTokenBalancesFallbackProviderFromEnv();
        assert.strictEqual(res.providerName, 'none');
        assert.strictEqual(res.statusCode, 'disabled');

        restoreEnv('TOKEN_BALANCES_FALLBACK_PROVIDER', origFallback);
        restoreEnv('MORALIS_API_KEY', origMoralisKey);
    });

    test('getTokenBalancesFallbackProviderFromEnv enables Moralis only when explicitly requested', async () => {
        const { getTokenBalancesFallbackProviderFromEnv } = await import('../src/real.js');
        const origFallback = process.env.TOKEN_BALANCES_FALLBACK_PROVIDER;
        const origMoralisKey = process.env.MORALIS_API_KEY;
        process.env.TOKEN_BALANCES_FALLBACK_PROVIDER = 'moralis';
        process.env.MORALIS_API_KEY = 'moralis-test-key';

        const res = getTokenBalancesFallbackProviderFromEnv();
        assert.strictEqual(res.providerName, 'moralis');
        assert.strictEqual(res.statusCode, 'connected');

        restoreEnv('TOKEN_BALANCES_FALLBACK_PROVIDER', origFallback);
        restoreEnv('MORALIS_API_KEY', origMoralisKey);
    });

    test('NoneTokenSecurityProvider returns unknown without throwing', async () => {
        const provider = new NoneTokenSecurityProvider();
        const security = await provider.getTokenSecurity({ chainId: 8453, tokenAddresses: ['native', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'] });
        assert.strictEqual(security.length, 1);
        assert.strictEqual(security[0].provider, 'none');
        assert.strictEqual(security[0].status, 'unknown');
    });

    test('GoPlusTokenSecurityProvider maps high-risk flags correctly', async () => {
        clearTokenSecurityCacheForTests();
        const token = '0x1111111111111111111111111111111111111111';
        const mockFetch = mock.fn(async () => ({
            ok: true,
            json: async () => ({
                result: {
                    [token]: {
                        is_honeypot: '1',
                        is_blacklisted: '1',
                        is_mintable: '1',
                        is_open_source: '0',
                        buy_tax: '0.12',
                        sell_tax: '0.15',
                    }
                }
            })
        } as Response));
        global.fetch = mockFetch as unknown as typeof fetch;

        const provider = new GoPlusTokenSecurityProvider(undefined, 1000);
        const [security] = await provider.getTokenSecurity({ chainId: 8453, tokenAddresses: [token] });

        assert.strictEqual(security.status, 'high-risk');
        assert.strictEqual(security.flags.isHoneypot, true);
        assert.strictEqual(security.flags.hasBlacklist, true);
        assert.strictEqual(security.flags.isMintable, true);
        assert.ok(security.rawRiskLabels.some(label => label.includes('Honeypot')));
        mock.restoreAll();
    });

    test('GoPlusTokenSecurityProvider uses API key header only and never private key env', async () => {
        clearTokenSecurityCacheForTests();
        process.env.PRIVATE_KEY = 'super-secret-private-key';
        const token = '0x2222222222222222222222222222222222222222';
        const mockFetch = mock.fn(async (_url: string | URL | Request, options?: RequestInit) => {
            const serializedOptions = JSON.stringify(options || {});
            assert.ok(!serializedOptions.includes('super-secret-private-key'));
            assert.ok(serializedOptions.includes('test-goplus-key'));
            return {
                ok: true,
                json: async () => ({ result: { [token]: { is_honeypot: '0', is_open_source: '1' } } })
            } as Response;
        });
        global.fetch = mockFetch as unknown as typeof fetch;

        const provider = new GoPlusTokenSecurityProvider('test-goplus-key', 1000);
        const [security] = await provider.getTokenSecurity({ chainId: 8453, tokenAddresses: [token] });
        assert.strictEqual(security.status, 'ok');
        assert.strictEqual(mockFetch.mock.calls.length, 1);
        delete process.env.PRIVATE_KEY;
        mock.restoreAll();
    });

    test('GoPlusTokenSecurityProvider failure returns failed results', async () => {
        clearTokenSecurityCacheForTests();
        const originalProvider = process.env.TOKEN_SECURITY_PROVIDER;
        process.env.TOKEN_SECURITY_PROVIDER = 'goplus';
        const mockFetch = mock.fn(async () => ({ ok: false, status: 500, statusText: 'Internal Server Error' }) as Response);
        global.fetch = mockFetch as unknown as typeof fetch;
        const provider = new GoPlusTokenSecurityProvider(undefined, 1000);
        const security = await provider.getTokenSecurity({ chainId: 8453, tokenAddresses: ['0x3333333333333333333333333333333333333333'] });
        assert.strictEqual(security[0].status, 'failed');
        assert.strictEqual(getTokenSecurityProviderFromEnv().statusCode, 'failed');
        restoreEnv('TOKEN_SECURITY_PROVIDER', originalProvider);
        clearTokenSecurityCacheForTests();
        mock.restoreAll();
    });

    test('mapGoPlusTokenSecurity handles warning-only proxy token', () => {
        const security = mapGoPlusTokenSecurity('0x4444444444444444444444444444444444444444', {
            is_proxy: '1',
            is_open_source: '1',
            is_mintable: '0',
            is_honeypot: '0'
        });
        assert.strictEqual(security.status, 'warning');
        assert.strictEqual(security.flags.isProxy, true);
    });
});
