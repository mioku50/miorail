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

    test('RealMoralisProvider wires an AbortSignal.timeout and propagates an abort as a rejection', async () => {
        const mockFetch = mock.fn(async (_url: string | URL | Request, options?: RequestInit) => {
            assert.ok(options?.signal instanceof AbortSignal, 'fetch must receive an AbortSignal so a hung request cannot block portfolio reads forever');
            // Simulate the platform aborting this request once AbortSignal.timeout fires.
            throw new DOMException('The operation was aborted.', 'AbortError');
        });
        global.fetch = mockFetch as unknown as typeof fetch;

        const provider = new RealMoralisProvider('fake-key', 25);
        await assert.rejects(() => provider.getWalletTokenBalances('0xabc'), /abort/i);
        mock.restoreAll();
    });

    test('RealCoinGeckoProvider wires an AbortSignal.timeout and propagates an abort as a rejection', async () => {
        const mockFetch = mock.fn(async (_url: string | URL | Request, options?: RequestInit) => {
            assert.ok(options?.signal instanceof AbortSignal, 'fetch must receive an AbortSignal so a hung request cannot block portfolio reads forever');
            throw new DOMException('The operation was aborted.', 'AbortError');
        });
        global.fetch = mockFetch as unknown as typeof fetch;

        const provider = new RealCoinGeckoProvider(25);
        await assert.rejects(() => provider.getSimplePrice(['ethereum'], ['usd']), /abort/i);
        mock.restoreAll();
    });

    test('RealDeFiLlamaProvider wires an AbortSignal.timeout and propagates an abort as a rejection', async () => {
        const mockFetch = mock.fn(async (_url: string | URL | Request, options?: RequestInit) => {
            assert.ok(options?.signal instanceof AbortSignal, 'fetch must receive an AbortSignal so a hung request cannot block portfolio reads forever');
            throw new DOMException('The operation was aborted.', 'AbortError');
        });
        global.fetch = mockFetch as unknown as typeof fetch;

        const provider = new RealDeFiLlamaProvider(25);
        await assert.rejects(() => provider.getProtocolTvl('uniswap'), /abort/i);
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

    test('a wallet holding more than fifteen tokens keeps the ones that sort last', async () => {
        // The exact shape of the 2026-09-08 report. Alchemy orders these by
        // contract address, and every B20 token begins with 0xb2, so the old
        // `slice(0, 15)` cut off precisely the tokenized stocks this product
        // exists to show. NVDAc sat nineteenth in a 22-token wallet and the
        // screen said the wallet did not hold it, minutes after a confirmed buy.
        const NVDAC = '0xb20000000000000000000078ee7ce2fe4908108c';
        const held = [
            ...Array.from({ length: 21 }, (_unused, index) =>
                '0x' + (index + 1).toString(16).padStart(2, '0') + 'a'.repeat(38),
            ),
            NVDAC,
        ];
        const mockFetch = mock.fn(async (_url: string | URL | Request, options?: RequestInit) => {
            const body = JSON.parse(String(options?.body || '{}'));
            if (body.method === 'alchemy_getTokenBalances') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        result: {
                            tokenBalances: held.map((contractAddress) => ({
                                contractAddress,
                                tokenBalance: '0xabcd',
                            })),
                        },
                    }),
                } as Response;
            }
            const address = String(body.params?.[0] ?? '');
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    result:
                        address === NVDAC
                            ? { symbol: 'NVDAc', name: 'Coinbase NVDA', decimals: 8 }
                            : { symbol: 'OTHER', name: 'Other', decimals: 18 },
                }),
            } as Response;
        });
        global.fetch = mockFetch as unknown as typeof fetch;

        const provider = new AlchemyTokenBalancesProvider('alchemy-key');
        const balances = await provider.getTokenBalances({ address: '0xabc', chainId: 8453 });

        assert.strictEqual(balances.length, 22);
        const nvda = balances.find((row) => row.address === NVDAC);
        assert.ok(nvda, 'the token that sorts last was dropped');
        assert.strictEqual(nvda!.symbol, 'NVDAc');
        // Its own decimals, not the 18 default: 0xabcd at 8 decimals is
        // 0.0004, and reading it as 18 would render 0.0000 and look like dust.
        assert.strictEqual(nvda!.decimals, 8);
        mock.restoreAll();
    });

    test('a metadata read that fails drops one token, not the rest of the wallet', async () => {
        const good = '0x' + '11'.repeat(20);
        const bad = '0x' + '22'.repeat(20);
        const mockFetch = mock.fn(async (_url: string | URL | Request, options?: RequestInit) => {
            const body = JSON.parse(String(options?.body || '{}'));
            if (body.method === 'alchemy_getTokenBalances') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        result: {
                            tokenBalances: [good, bad].map((contractAddress) => ({
                                contractAddress,
                                tokenBalance: '0x64',
                            })),
                        },
                    }),
                } as Response;
            }
            if (String(body.params?.[0] ?? '') === bad) {
                return { ok: false, status: 500, statusText: 'Server Error', json: async () => ({}) } as Response;
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({ result: { symbol: 'GOOD', name: 'Good', decimals: 18 } }),
            } as Response;
        });
        global.fetch = mockFetch as unknown as typeof fetch;

        const provider = new AlchemyTokenBalancesProvider('alchemy-key');
        const balances = await provider.getTokenBalances({ address: '0xabc', chainId: 8453 });

        assert.strictEqual(balances.length, 1);
        assert.strictEqual(balances[0].symbol, 'GOOD');
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

    test('GoPlusTokenSecurityProvider supports the public API without auth headers', async () => {
        clearTokenSecurityCacheForTests();
        process.env.PRIVATE_KEY = 'super-secret-private-key';
        const token = '0x2222222222222222222222222222222222222222';
        const mockFetch = mock.fn(async (_url: string | URL | Request, options?: RequestInit) => {
            const serializedOptions = JSON.stringify(options || {});
            assert.ok(!serializedOptions.includes('super-secret-private-key'));
            assert.ok(!serializedOptions.includes('Authorization'));
            assert.ok(!serializedOptions.includes('X-API-Key'));
            return {
                ok: true,
                json: async () => ({ result: { [token]: { is_honeypot: '0', is_open_source: '1' } } })
            } as Response;
        });
        global.fetch = mockFetch as unknown as typeof fetch;

        const provider = new GoPlusTokenSecurityProvider(undefined, 1000);
        const [security] = await provider.getTokenSecurity({ chainId: 8453, tokenAddresses: [token] });
        assert.strictEqual(security.status, 'ok');
        assert.strictEqual(mockFetch.mock.calls.length, 1);
        delete process.env.PRIVATE_KEY;
        mock.restoreAll();
    });

    test('GoPlus retries tokens omitted from a partial batch and keeps unknown results uncached', async () => {
        clearTokenSecurityCacheForTests();
        const originalProvider = process.env.TOKEN_SECURITY_PROVIDER;
        process.env.TOKEN_SECURITY_PROVIDER = 'goplus';
        const katana = '0x1111111111111111111111111111111111111111';
        const usdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
        const spam = '0x3333333333333333333333333333333333333333';
        const mockFetch = mock.fn(async (url: string | URL | Request) => {
            const addresses = new URL(String(url)).searchParams.get('contract_addresses') || '';
            if (addresses.includes(',')) {
                return { ok: true, json: async () => ({ result: {
                    [katana.toUpperCase()]: { is_honeypot: '0', is_open_source: '1' },
                } }) } as Response;
            }
            if (addresses.toLowerCase() === usdc.toLowerCase()) {
                return { ok: true, json: async () => ({ result: {
                    [usdc.toUpperCase()]: { is_honeypot: '0', is_open_source: '1' },
                } }) } as Response;
            }
            return { ok: true, json: async () => ({ result: {} }) } as Response;
        });
        global.fetch = mockFetch as unknown as typeof fetch;

        const provider = new GoPlusTokenSecurityProvider(undefined, 1000);
        const results = await provider.getTokenSecurity({ chainId: 8453, tokenAddresses: [katana, usdc, spam] });
        assert.deepStrictEqual(results.map((result) => result.status), ['ok', 'ok', 'failed']);
        assert.strictEqual(getTokenSecurityProviderFromEnv().statusCode, 'partial');
        assert.strictEqual(mockFetch.mock.calls.length, 3);

        await provider.getTokenSecurity({ chainId: 8453, tokenAddresses: [katana, usdc, spam] });
        assert.strictEqual(mockFetch.mock.calls.length, 5, 'only the unknown spam result is retried and remains uncached');
        assert.strictEqual(getTokenSecurityProviderFromEnv().statusCode, 'partial');
        restoreEnv('TOKEN_SECURITY_PROVIDER', originalProvider);
        clearTokenSecurityCacheForTests();
        mock.restoreAll();
    });

    test('forceFresh bypasses a cached canonical USDC verdict for action security', async () => {
        clearTokenSecurityCacheForTests();
        const usdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
        let verdict = '0';
        const mockFetch = mock.fn(async () => ({
            ok: true,
            json: async () => ({ result: { [usdc]: { is_honeypot: verdict, is_open_source: '1' } } }),
        } as Response));
        global.fetch = mockFetch as unknown as typeof fetch;
        const provider = new GoPlusTokenSecurityProvider(undefined, 1000);
        assert.equal((await provider.getTokenSecurity({ chainId: 8453, tokenAddresses: [usdc] }))[0].status, 'ok');
        verdict = '1';
        assert.equal((await provider.getTokenSecurity({ chainId: 8453, tokenAddresses: [usdc] }))[0].status, 'ok', 'normal portfolio read may use cache');
        assert.equal((await provider.getTokenSecurity({ chainId: 8453, tokenAddresses: [usdc], forceFresh: true }))[0].status, 'high-risk');
        assert.equal(mockFetch.mock.calls.length, 2);
        mock.restoreAll();
    });

    test('GoPlus app credentials use the official backend access-token lifecycle', async () => {
        clearTokenSecurityCacheForTests();
        const token = '0x4444444444444444444444444444444444444444';
        const mockFetch = mock.fn(async (url: string | URL | Request, options?: RequestInit) => {
            if (String(url).endsWith('/api/v1/token')) {
                const body = JSON.parse(String(options?.body || '{}'));
                assert.equal(body.app_key, 'app-key');
                assert.match(body.sign, /^[a-f0-9]{40}$/);
                assert.equal(JSON.stringify(options).includes('app-secret'), false);
                return { ok: true, json: async () => ({ result: { access_token: 'backend-token', expires_in: 3600 } }) } as Response;
            }
            assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer backend-token');
            return { ok: true, json: async () => ({ result: { [token]: { is_open_source: '1' } } }) } as Response;
        });
        global.fetch = mockFetch as unknown as typeof fetch;
        const provider = new GoPlusTokenSecurityProvider({ appKey: 'app-key', appSecret: 'app-secret' }, 1000);
        const [security] = await provider.getTokenSecurity({ chainId: 8453, tokenAddresses: [token] });
        assert.equal(security.status, 'ok');
        assert.equal(mockFetch.mock.calls.length, 2);
        mock.restoreAll();
    });

    test('GoPlus auth failure falls back to public API with sanitized diagnostics', async () => {
        clearTokenSecurityCacheForTests();
        const originalProvider = process.env.TOKEN_SECURITY_PROVIDER;
        process.env.TOKEN_SECURITY_PROVIDER = 'goplus';
        const token = '0x5555555555555555555555555555555555555555';
        const mockFetch = mock.fn(async (url: string | URL | Request, options?: RequestInit) => {
            if (String(url).endsWith('/api/v1/token')) {
                return { ok: false, status: 401, statusText: 'Unauthorized' } as Response;
            }
            assert.equal(JSON.stringify(options || {}).includes('Authorization'), false);
            return { ok: true, json: async () => ({ result: { [token]: { is_open_source: '1' } } }) } as Response;
        });
        global.fetch = mockFetch as unknown as typeof fetch;
        const provider = new GoPlusTokenSecurityProvider({ appKey: 'app-key', appSecret: 'app-secret' }, 1000);
        assert.equal((await provider.getTokenSecurity({ chainId: 8453, tokenAddresses: [token] }))[0].status, 'ok');
        const diagnostics = getTokenSecurityProviderFromEnv();
        assert.equal(diagnostics.authMode, 'public_fallback');
        assert.equal(diagnostics.errorCode, 'goplus_auth_failed');
        assert.equal(JSON.stringify(diagnostics).includes('app-secret'), false);
        restoreEnv('TOKEN_SECURITY_PROVIDER', originalProvider);
        clearTokenSecurityCacheForTests();
        mock.restoreAll();
    });

    test('an exhausted app key drops the credential and answers from the public tier', async () => {
        // Measured 2026-08-22: the GoPlus free plan meters app-key traffic
        // against a monthly credit balance while the unauthenticated tier is
        // not metered, and both return the identical token_security payload.
        // A spent quota must therefore cost us nothing — retrying the same
        // exhausted key twice and giving up is how a credential becomes an
        // outage.
        clearTokenSecurityCacheForTests();
        const originalProvider = process.env.TOKEN_SECURITY_PROVIDER;
        process.env.TOKEN_SECURITY_PROVIDER = 'goplus';
        const token = '0x6666666666666666666666666666666666666666';
        const authorizedAttempts: boolean[] = [];
        const mockFetch = mock.fn(async (url: string | URL | Request, options?: RequestInit) => {
            if (String(url).endsWith('/api/v1/token')) {
                return { ok: true, json: async () => ({ result: { access_token: 'backend-token', expires_in: 3600 } }) } as Response;
            }
            const authorized = Boolean((options?.headers as Record<string, string> | undefined)?.Authorization);
            authorizedAttempts.push(authorized);
            if (authorized) return { ok: false, status: 429, statusText: 'Too Many Requests' } as Response;
            return { ok: true, json: async () => ({ result: { [token]: { is_open_source: '1' } } }) } as Response;
        });
        global.fetch = mockFetch as unknown as typeof fetch;
        const provider = new GoPlusTokenSecurityProvider({ appKey: 'app-key', appSecret: 'app-secret' }, 1000);
        const [security] = await provider.getTokenSecurity({ chainId: 8453, tokenAddresses: [token] });
        assert.equal(security.status, 'ok', 'a throttled key must not become an unavailable verdict');
        assert.deepEqual(authorizedAttempts, [true, false], 'the retry must drop the credential, not repeat it');
        const diagnostics = getTokenSecurityProviderFromEnv();
        assert.equal(diagnostics.authMode, 'public_fallback');
        assert.equal(diagnostics.errorCode, 'goplus_rate_limited');
        restoreEnv('TOKEN_SECURITY_PROVIDER', originalProvider);
        clearTokenSecurityCacheForTests();
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
