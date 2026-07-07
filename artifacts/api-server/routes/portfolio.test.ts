import test, { describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { app } from '../app';
import { clearTokenSecurityCacheForTests } from '@mioagent/data-providers';
import { clearTokenBalancesCacheForTests, setTokenBalancesCacheForTests } from '../lib/portfolioAnalysis';

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe('Portfolio API', () => {
  beforeEach(() => {
    clearTokenBalancesCacheForTests();
  });
  test('GET /api/portfolio returns 400 when address is missing', async () => {
    const response = await request(app).get('/api/portfolio');
    assert.strictEqual(response.status, 400);
    assert.strictEqual(response.body.error, 'Wallet address not configured');
  });

  test('GET /api/portfolio returns ETH balance and token status when address is provided', async () => {
    process.env.TOKEN_BALANCES_PROVIDER = 'none';
    process.env.PRICE_PROVIDER = 'none';
    process.env.TOKEN_SECURITY_PROVIDER = 'none';
    process.env.APPROVAL_PROVIDER = 'none';
    const mockFetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({
        result: '0xde0b6b3a7640000' // 1 ETH in wei
      })
    } as Response));
    global.fetch = mockFetch as unknown as typeof fetch;

    const response = await request(app).get('/api/portfolio?address=0x1234567890123456789012345678901234567890');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.tokens.length, 1);
    assert.strictEqual(response.body.tokens[0].symbol, 'ETH');
    assert.strictEqual(response.body.tokens[0].balanceFormatted, '1.0000');
    assert.strictEqual(response.body.providerStatus, 'Token balances provider not configured');
    assert.strictEqual(response.body.providers.risk, 'disabled');
    assert.strictEqual(response.body.providers.riskProvider, 'none');

    mock.restoreAll();
  });

  test('GET /api/portfolio returns ERC-20 balances when provider is configured to mock', async () => {
    process.env.TOKEN_BALANCES_PROVIDER = 'mock';
    process.env.PRICE_PROVIDER = 'none';
    process.env.TOKEN_SECURITY_PROVIDER = 'none';
    process.env.APPROVAL_PROVIDER = 'none';
    const mockFetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({
        result: '0xde0b6b3a7640000'
      })
    } as Response));
    global.fetch = mockFetch as unknown as typeof fetch;

    const response = await request(app).get('/api/portfolio?address=0x1234567890123456789012345678901234567890');
    assert.strictEqual(response.status, 200);
    assert.ok(response.body.tokens.length > 1);
    assert.strictEqual(response.body.providerStatus, 'mock');
    const usdc = response.body.tokens.find((t: { symbol: string }) => t.symbol === 'USDC');
    assert.ok(usdc);
    assert.strictEqual(usdc.balanceFormatted, '15.0000');

    mock.restoreAll();
  });

  test('GET /api/portfolio returns ETH-only partial response when provider fails', async () => {
    process.env.TOKEN_BALANCES_PROVIDER = 'moralis';
    process.env.PRICE_PROVIDER = 'none';
    process.env.TOKEN_SECURITY_PROVIDER = 'none';
    process.env.APPROVAL_PROVIDER = 'none';
    process.env.MORALIS_API_KEY = 'test-key';
    const mockFetch = mock.fn(async (url: string | URL | Request) => {
      if (url.toString().includes('moralis.io')) {
        return { ok: false, statusText: 'Internal Server Error' } as Response;
      }
      return {
        ok: true,
        json: async () => ({ result: '0xde0b6b3a7640000' })
      } as Response;
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const response = await request(app).get('/api/portfolio?address=0x8888567890123456789012345678901234568888');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.tokens.length, 1);
    assert.strictEqual(response.body.tokens[0].symbol, 'ETH');
    assert.strictEqual(response.body.providerStatus, 'Token balances provider failed. Showing native ETH only.');
    assert.strictEqual(response.body.providers.tokenBalances, 'failed');

    mock.restoreAll();
  });

  test('GET /api/portfolio returns Moralis connected status and includes suspicious tokens', async () => {
    process.env.TOKEN_BALANCES_PROVIDER = 'moralis';
    process.env.PRICE_PROVIDER = 'none';
    process.env.TOKEN_SECURITY_PROVIDER = 'none';
    process.env.APPROVAL_PROVIDER = 'none';
    process.env.MORALIS_API_KEY = 'test-key';
    const mockFetch = mock.fn(async (url: string | URL | Request) => {
      if (url.toString().includes('moralis.io')) {
        return {
          ok: true,
          json: async () => ([
            {
              token_address: '0x1111111111111111111111111111111111111111',
              balance: '1000000000000000000',
              decimals: 18,
              symbol: 'SPAM.COM',
              name: 'Visit spam.com to claim 10000 USD',
              possible_spam: true,
              verified_contract: false
            }
          ])
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({ result: '0xde0b6b3a7640000' })
      } as Response;
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const response = await request(app).get('/api/portfolio?address=0x1234567890123456789012345678901234567890');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.providerStatus, 'Moralis connected');
    assert.strictEqual(response.body.providers.tokenBalances, 'connected');
    assert.strictEqual(response.body.tokens.length, 2);
    const spamToken = response.body.tokens.find((t: { symbol: string }) => t.symbol === 'SPAM.COM');
    assert.ok(spamToken);
    assert.strictEqual(spamToken.possibleSpam, true);

    mock.restoreAll();
  });

  test('GET /api/portfolio returns token security when GoPlus provider is configured', async () => {
    clearTokenSecurityCacheForTests();
    const origTokenProvider = process.env.TOKEN_BALANCES_PROVIDER;
    const origPriceProvider = process.env.PRICE_PROVIDER;
    const origSecurityProvider = process.env.TOKEN_SECURITY_PROVIDER;
    process.env.TOKEN_BALANCES_PROVIDER = 'mock';
    process.env.PRICE_PROVIDER = 'mock';
    process.env.TOKEN_SECURITY_PROVIDER = 'goplus';
    const mockFetch = mock.fn(async (url: string | URL | Request) => {
      if (url.toString().includes('gopluslabs.io')) {
        return {
          ok: true,
          json: async () => ({
            result: {
              '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': {
                is_honeypot: '0',
                is_open_source: '1',
                is_proxy: '0',
                is_mintable: '0'
              }
            }
          })
        } as Response;
      }
      return { ok: true, json: async () => ({ result: '0xde0b6b3a7640000' }) } as Response;
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const response = await request(app).get('/api/portfolio?address=0x1234567890123456789012345678901234567890');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.providers.risk, 'connected');
    assert.strictEqual(response.body.providers.riskProvider, 'goplus');
    const usdc = response.body.tokens.find((t: { symbol: string }) => t.symbol === 'USDC');
    assert.ok(usdc.security);
    assert.strictEqual(usdc.security.status, 'ok');

    restoreEnv('TOKEN_BALANCES_PROVIDER', origTokenProvider);
    restoreEnv('PRICE_PROVIDER', origPriceProvider);
    restoreEnv('TOKEN_SECURITY_PROVIDER', origSecurityProvider);
    mock.restoreAll();
  });

  test('GET /api/portfolio keeps balances visible when GoPlus fails', async () => {
    clearTokenSecurityCacheForTests();
    const origTokenProvider = process.env.TOKEN_BALANCES_PROVIDER;
    const origPriceProvider = process.env.PRICE_PROVIDER;
    const origSecurityProvider = process.env.TOKEN_SECURITY_PROVIDER;
    process.env.TOKEN_BALANCES_PROVIDER = 'mock';
    process.env.PRICE_PROVIDER = 'mock';
    process.env.TOKEN_SECURITY_PROVIDER = 'goplus';
    const mockFetch = mock.fn(async (url: string | URL | Request) => {
      if (url.toString().includes('gopluslabs.io')) {
        return { ok: false, status: 500, statusText: 'Internal Server Error' } as Response;
      }
      return { ok: true, json: async () => ({ result: '0xde0b6b3a7640000' }) } as Response;
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const response = await request(app).get('/api/portfolio?address=0x1234567890123456789012345678901234567890');
    assert.strictEqual(response.status, 200);
    assert.ok(response.body.tokens.length > 1);
    assert.strictEqual(response.body.providers.risk, 'failed');
    const usdc = response.body.tokens.find((t: { symbol: string }) => t.symbol === 'USDC');
    assert.strictEqual(usdc.security.status, 'failed');

    restoreEnv('TOKEN_BALANCES_PROVIDER', origTokenProvider);
    restoreEnv('PRICE_PROVIDER', origPriceProvider);
    restoreEnv('TOKEN_SECURITY_PROVIDER', origSecurityProvider);
    mock.restoreAll();
  });

  test('GET /api/portfolio caches provider results within TTL (second request does not re-fetch)', async () => {
    const origTokenProvider = process.env.TOKEN_BALANCES_PROVIDER;
    const origPriceProvider = process.env.PRICE_PROVIDER;
    const origSecurityProvider = process.env.TOKEN_SECURITY_PROVIDER;
    const origApprovalProvider = process.env.APPROVAL_PROVIDER;
    const origMoralisKey = process.env.MORALIS_API_KEY;
    process.env.TOKEN_BALANCES_PROVIDER = 'moralis';
    process.env.PRICE_PROVIDER = 'none';
    process.env.TOKEN_SECURITY_PROVIDER = 'none';
    process.env.APPROVAL_PROVIDER = 'none';
    process.env.MORALIS_API_KEY = 'test-key';
    const mockFetch = mock.fn(async (url: string | URL | Request) => {
      if (url.toString().includes('moralis.io')) {
        return {
          ok: true,
          json: async () => ([
            { token_address: '0x1111111111111111111111111111111111111111', balance: '1000000000000000000', decimals: 18, symbol: 'TST', name: 'Test Token' }
          ])
        } as Response;
      }
      return { ok: true, json: async () => ({ result: '0xde0b6b3a7640000' }) } as Response;
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const addr = '0x1234567890123456789012345678901234567890';
    const first = await request(app).get(`/api/portfolio?address=${addr}`);
    assert.strictEqual(first.status, 200);
    assert.strictEqual(first.body.dataFreshness, 'live');
    const moralisCallsAfterFirst = mockFetch.mock.calls.filter((c: any) => String(c.arguments[0]).includes('moralis.io')).length;
    assert.strictEqual(moralisCallsAfterFirst, 1);

    const second = await request(app).get(`/api/portfolio?address=${addr}`);
    assert.strictEqual(second.status, 200);
    assert.strictEqual(second.body.dataFreshness, 'cached');
    const moralisCallsAfterSecond = mockFetch.mock.calls.filter((c: any) => String(c.arguments[0]).includes('moralis.io')).length;
    // Second request must be served from cache — no additional Moralis call.
    assert.strictEqual(moralisCallsAfterSecond, 1);

    restoreEnv('TOKEN_BALANCES_PROVIDER', origTokenProvider);
    restoreEnv('PRICE_PROVIDER', origPriceProvider);
    restoreEnv('TOKEN_SECURITY_PROVIDER', origSecurityProvider);
    restoreEnv('APPROVAL_PROVIDER', origApprovalProvider);
    restoreEnv('MORALIS_API_KEY', origMoralisKey);
    mock.restoreAll();
  });

  test('GET /api/portfolio makes no external provider calls and reports disabled when all providers = none', async () => {
    const origBalances = process.env.TOKEN_BALANCES_PROVIDER;
    const origPrice = process.env.PRICE_PROVIDER;
    const origSecurity = process.env.TOKEN_SECURITY_PROVIDER;
    const origApproval = process.env.APPROVAL_PROVIDER;
    process.env.TOKEN_BALANCES_PROVIDER = 'none';
    process.env.PRICE_PROVIDER = 'none';
    process.env.TOKEN_SECURITY_PROVIDER = 'none';
    process.env.APPROVAL_PROVIDER = 'none';

    // Any fetch that is not the Base RPC eth_getBalance would be an unwanted external provider call.
    const mockFetch = mock.fn(async (url: string | URL | Request) => {
      assert.ok(
        String(url).includes('base.org') || String(url).includes('alchemy.com'),
        `Unexpected external provider HTTP call: ${String(url)}`,
      );
      return { ok: true, json: async () => ({ result: '0xde0b6b3a7640000' }) } as Response;
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const response = await request(app).get('/api/portfolio?address=0x1234567890123456789012345678901234567890');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.providers.tokenBalances, 'disabled');
    assert.strictEqual(response.body.providers.prices, 'disabled');
    assert.strictEqual(response.body.providers.risk, 'disabled');
    assert.strictEqual(response.body.providers.approvals, 'disabled');
    assert.strictEqual(response.body.providerCallsMade, 0);

    restoreEnv('TOKEN_BALANCES_PROVIDER', origBalances);
    restoreEnv('PRICE_PROVIDER', origPrice);
    restoreEnv('TOKEN_SECURITY_PROVIDER', origSecurity);
    restoreEnv('APPROVAL_PROVIDER', origApproval);
    mock.restoreAll();
  });

  test('GET /api/portfolio normal refresh uses Alchemy/CoinGecko and does not call Moralis approvals', async () => {
    const origBalances = process.env.TOKEN_BALANCES_PROVIDER;
    const origPrice = process.env.PRICE_PROVIDER;
    const origSecurity = process.env.TOKEN_SECURITY_PROVIDER;
    const origApproval = process.env.APPROVAL_PROVIDER;
    const origAlchemyKey = process.env.ALCHEMY_API_KEY;
    const origMoralisKey = process.env.MORALIS_API_KEY;
    process.env.TOKEN_BALANCES_PROVIDER = 'alchemy';
    process.env.PRICE_PROVIDER = 'coingecko';
    process.env.TOKEN_SECURITY_PROVIDER = 'none';
    process.env.APPROVAL_PROVIDER = 'moralis';
    process.env.ALCHEMY_API_KEY = 'alchemy-test-key';
    process.env.MORALIS_API_KEY = 'moralis-test-key';

    const wallet = '0xaaaa56789012345678901234567890123456aaaa';
    const usdc = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    const mockFetch = mock.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlString = String(url);
      assert.ok(!urlString.includes('moralis.io'), `normal portfolio scan must not call Moralis: ${urlString}`);
      if (urlString.includes('alchemy.com')) {
        const body = JSON.parse(String(init?.body || '{}'));
        if (body.method === 'alchemy_getTokenBalances') {
          return {
            ok: true,
            json: async () => ({ result: { tokenBalances: [{ contractAddress: usdc, tokenBalance: '0xe4e1c0' }] } })
          } as Response;
        }
        if (body.method === 'alchemy_getTokenMetadata') {
          return {
            ok: true,
            json: async () => ({ result: { symbol: 'USDC', name: 'USD Coin', decimals: 6, logo: null } })
          } as Response;
        }
      }
      if (urlString.includes('api.coingecko.com/api/v3/simple/token_price/base')) {
        return { ok: true, json: async () => ({ [usdc]: { usd: 1 } }) } as Response;
      }
      if (urlString.includes('api.coingecko.com/api/v3/simple/price')) {
        return { ok: true, json: async () => ({ ethereum: { usd: 3000 } }) } as Response;
      }
      return { ok: true, json: async () => ({ result: '0xde0b6b3a7640000' }) } as Response;
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const response = await request(app).get(`/api/portfolio?walletAddress=${wallet}&chainEnv=mainnet-readonly&refresh=1`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.body.analysis);
    assert.strictEqual(response.body.analysis.totalTokens, 2);
    assert.strictEqual(response.body.analysis.providerContext.tokenBalancesProvider, 'alchemy');
    assert.strictEqual(response.body.analysis.providerContext.priceProvider, 'coingecko');
    assert.strictEqual(response.body.analysis.approvalSummary.status, 'not_requested');
    assert.strictEqual(response.body.approvalScan.status, 'not_requested');
    assert.strictEqual(response.body.providerCallSummary.balances.provider, 'alchemy');
    assert.strictEqual(response.body.providerCallSummary.balances.providerCalled, true);
    assert.strictEqual(response.body.providerCallSummary.approvals.provider, 'moralis');
    assert.strictEqual(response.body.providerCallSummary.approvals.providerCalled, false);
    const moralisCalls = mockFetch.mock.calls.filter((c: any) => String(c.arguments[0]).includes('moralis.io')).length;
    assert.strictEqual(moralisCalls, 0);

    restoreEnv('TOKEN_BALANCES_PROVIDER', origBalances);
    restoreEnv('PRICE_PROVIDER', origPrice);
    restoreEnv('TOKEN_SECURITY_PROVIDER', origSecurity);
    restoreEnv('APPROVAL_PROVIDER', origApproval);
    restoreEnv('ALCHEMY_API_KEY', origAlchemyKey);
    restoreEnv('MORALIS_API_KEY', origMoralisKey);
    mock.restoreAll();
  });

  test('GET /api/portfolio includeApprovals explicitly runs approvals and returns approval summary aliases', async () => {
    const origBalances = process.env.TOKEN_BALANCES_PROVIDER;
    const origPrice = process.env.PRICE_PROVIDER;
    const origSecurity = process.env.TOKEN_SECURITY_PROVIDER;
    const origApproval = process.env.APPROVAL_PROVIDER;
    const origAlchemyKey = process.env.ALCHEMY_API_KEY;
    const origMoralisKey = process.env.MORALIS_API_KEY;
    process.env.TOKEN_BALANCES_PROVIDER = 'alchemy';
    process.env.PRICE_PROVIDER = 'coingecko';
    process.env.TOKEN_SECURITY_PROVIDER = 'none';
    process.env.APPROVAL_PROVIDER = 'moralis';
    process.env.ALCHEMY_API_KEY = 'alchemy-test-key';
    process.env.MORALIS_API_KEY = 'moralis-test-key';

    const wallet = '0xbbbb56789012345678901234567890123456bbbb';
    const usdc = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    const spender = '0x9999999999999999999999999999999999999999';
    const mockFetch = mock.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlString = String(url);
      if (urlString.includes('moralis.io') && urlString.includes('/approvals')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            result: [{
              token: { address: usdc, symbol: 'USDC', name: 'USD Coin', decimals: '6' },
              spender: { address: spender },
              value: '115792089237316195423570985008687907853269984665640564039457584007913129639935',
              value_formatted: 'Unlimited',
            }]
          })
        } as Response;
      }
      if (urlString.includes('alchemy.com')) {
        const body = JSON.parse(String(init?.body || '{}'));
        if (body.method === 'alchemy_getTokenBalances') {
          return {
            ok: true,
            json: async () => ({ result: { tokenBalances: [{ contractAddress: usdc, tokenBalance: '0xe4e1c0' }] } })
          } as Response;
        }
        if (body.method === 'alchemy_getTokenMetadata') {
          return {
            ok: true,
            json: async () => ({ result: { symbol: 'USDC', name: 'USD Coin', decimals: 6, logo: null } })
          } as Response;
        }
      }
      if (urlString.includes('api.coingecko.com/api/v3/simple/token_price/base')) {
        return { ok: true, json: async () => ({ [usdc]: { usd: 1 } }) } as Response;
      }
      if (urlString.includes('api.coingecko.com/api/v3/simple/price')) {
        return { ok: true, json: async () => ({ ethereum: { usd: 3000 } }) } as Response;
      }
      return { ok: true, json: async () => ({ result: '0xde0b6b3a7640000' }) } as Response;
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const response = await request(app).get(`/api/portfolio?walletAddress=${wallet}&chainEnv=mainnet-readonly&refresh=1&includeApprovals=1`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.providerCallSummary.approvals.provider, 'moralis');
    assert.strictEqual(response.body.providerCallSummary.approvals.providerCalled, true);
    assert.strictEqual(response.body.approvalSummary.totalApprovals, 1);
    assert.strictEqual(response.body.analysis.approvalSummary.totalApprovals, 1);
    assert.strictEqual(response.body.approvals.length, 1);
    assert.strictEqual(response.body.analysis.approvals.length, 1);
    assert.ok(response.body.analysis.approvalFindings.length >= 1);
    const moralisCalls = mockFetch.mock.calls.filter((c: any) => String(c.arguments[0]).includes('moralis.io') && String(c.arguments[0]).includes('/approvals')).length;
    assert.strictEqual(moralisCalls, 1);

    restoreEnv('TOKEN_BALANCES_PROVIDER', origBalances);
    restoreEnv('PRICE_PROVIDER', origPrice);
    restoreEnv('TOKEN_SECURITY_PROVIDER', origSecurity);
    restoreEnv('APPROVAL_PROVIDER', origApproval);
    restoreEnv('ALCHEMY_API_KEY', origAlchemyKey);
    restoreEnv('MORALIS_API_KEY', origMoralisKey);
    mock.restoreAll();
  });

  test('GET /api/portfolio reports Alchemy rate limit without automatic Moralis fallback', async () => {
    const origBalances = process.env.TOKEN_BALANCES_PROVIDER;
    const origFallback = process.env.TOKEN_BALANCES_FALLBACK_PROVIDER;
    const origPrice = process.env.PRICE_PROVIDER;
    const origSecurity = process.env.TOKEN_SECURITY_PROVIDER;
    const origApproval = process.env.APPROVAL_PROVIDER;
    const origAlchemyKey = process.env.ALCHEMY_API_KEY;
    const origMoralisKey = process.env.MORALIS_API_KEY;
    process.env.TOKEN_BALANCES_PROVIDER = 'alchemy';
    process.env.TOKEN_BALANCES_FALLBACK_PROVIDER = 'none';
    process.env.PRICE_PROVIDER = 'none';
    process.env.TOKEN_SECURITY_PROVIDER = 'none';
    process.env.APPROVAL_PROVIDER = 'moralis';
    process.env.ALCHEMY_API_KEY = 'alchemy-test-key';
    process.env.MORALIS_API_KEY = 'moralis-test-key';

    const wallet = '0xcccc56789012345678901234567890123456cccc';
    const mockFetch = mock.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const bodyText = String(init?.body || '');
      if (bodyText.includes('alchemy_getTokenBalances')) {
        return {
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          json: async () => ({ error: { message: 'Your app has been rate-limited due to unusually high global traffic.' } }),
        } as Response;
      }
      assert.ok(!String(_url).includes('moralis.io'), `normal portfolio scan must not call Moralis on Alchemy 429: ${String(_url)}`);
      return { ok: true, json: async () => ({ result: '0xde0b6b3a7640000' }) } as Response;
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const response = await request(app).get(`/api/portfolio?walletAddress=${wallet}&chainEnv=mainnet-readonly&refresh=1`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.tokens.length, 1);
    assert.strictEqual(response.body.tokens[0].symbol, 'ETH');
    assert.strictEqual(response.body.providerStatus, 'Alchemy rate-limited. Showing cached/native balance data.');
    assert.strictEqual(response.body.dataFreshness, 'partial');
    assert.strictEqual(response.body.providers.tokenBalances, 'rate_limited');
    assert.strictEqual(response.body.providerBudgetStatus.exhausted, true);
    assert.ok(response.body.providerBudgetStatus.providers.includes('alchemy'));
    assert.deepStrictEqual(
      {
        provider: response.body.providerCallSummary.balances.provider,
        status: response.body.providerCallSummary.balances.status,
        providerCalled: response.body.providerCallSummary.balances.providerCalled,
        budgetExhausted: response.body.providerCallSummary.balances.budgetExhausted,
        requested: response.body.providerCallSummary.balances.requested,
      },
      {
        provider: 'alchemy',
        status: 'rate_limited',
        providerCalled: true,
        budgetExhausted: true,
        requested: true,
      },
    );
    assert.strictEqual(response.body.providerCallSummary.balanceFallback.provider, 'none');
    assert.strictEqual(response.body.providerCallSummary.balanceFallback.requested, false);
    assert.strictEqual(response.body.providerContext.tokenBalancesProvider, 'alchemy');
    assert.strictEqual(response.body.providerContext.priceProvider, 'none');
    assert.strictEqual(response.body.providerContext.balancesStatus, 'rate_limited');
    assert.strictEqual(response.body.analysis.providerContext.balancesStatus, 'rate_limited');
    assert.strictEqual(response.body.analysis.totalTokens, 1);
    const moralisCalls = mockFetch.mock.calls.filter((c: any) => String(c.arguments[0]).includes('moralis.io')).length;
    assert.strictEqual(moralisCalls, 0);

    restoreEnv('TOKEN_BALANCES_PROVIDER', origBalances);
    restoreEnv('TOKEN_BALANCES_FALLBACK_PROVIDER', origFallback);
    restoreEnv('PRICE_PROVIDER', origPrice);
    restoreEnv('TOKEN_SECURITY_PROVIDER', origSecurity);
    restoreEnv('APPROVAL_PROVIDER', origApproval);
    restoreEnv('ALCHEMY_API_KEY', origAlchemyKey);
    restoreEnv('MORALIS_API_KEY', origMoralisKey);
    mock.restoreAll();
  });

  test('GET /api/portfolio prefers stale Alchemy cache over native-only fallback on rate limit', async () => {
    const origBalances = process.env.TOKEN_BALANCES_PROVIDER;
    const origFallback = process.env.TOKEN_BALANCES_FALLBACK_PROVIDER;
    const origPrice = process.env.PRICE_PROVIDER;
    const origSecurity = process.env.TOKEN_SECURITY_PROVIDER;
    const origApproval = process.env.APPROVAL_PROVIDER;
    const origAlchemyKey = process.env.ALCHEMY_API_KEY;
    const origMoralisKey = process.env.MORALIS_API_KEY;
    process.env.TOKEN_BALANCES_PROVIDER = 'alchemy';
    process.env.TOKEN_BALANCES_FALLBACK_PROVIDER = 'none';
    process.env.PRICE_PROVIDER = 'none';
    process.env.TOKEN_SECURITY_PROVIDER = 'none';
    process.env.APPROVAL_PROVIDER = 'moralis';
    process.env.ALCHEMY_API_KEY = 'alchemy-test-key';
    process.env.MORALIS_API_KEY = 'moralis-test-key';

    const wallet = '0xdddd56789012345678901234567890123456dddd';
    const aero = '0x940181a94a35a4569e4529a3cdfb74e38fd98631';
    await setTokenBalancesCacheForTests(8453, wallet, [{
      symbol: 'AERO',
      name: 'Aerodrome',
      address: aero,
      balance: '2500000000000000000',
      balanceFormatted: '2.5000',
      decimals: 18,
      verified: true,
      possibleSpam: false,
    }], 'alchemy');

    const mockFetch = mock.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const bodyText = String(init?.body || '');
      if (bodyText.includes('alchemy_getTokenBalances')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ error: { code: 429, message: 'rate limited' } }),
        } as Response;
      }
      assert.ok(!String(_url).includes('moralis.io'), `stale Alchemy cache must avoid Moralis fallback: ${String(_url)}`);
      return { ok: true, json: async () => ({ result: '0xde0b6b3a7640000' }) } as Response;
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const response = await request(app).get(`/api/portfolio?walletAddress=${wallet}&chainEnv=mainnet-readonly&refresh=1`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.providerStatus, 'Alchemy rate-limited. Showing cached/native balance data.');
    assert.strictEqual(response.body.dataFreshness, 'stale');
    assert.strictEqual(response.body.providers.tokenBalances, 'rate_limited');
    assert.strictEqual(response.body.providerCallSummary.balances.provider, 'alchemy');
    assert.strictEqual(response.body.providerCallSummary.balances.status, 'rate_limited');
    assert.strictEqual(response.body.providerCallSummary.balances.providerCalled, true);
    assert.strictEqual(response.body.providerCallSummary.balances.budgetExhausted, true);
    assert.strictEqual(response.body.providerContext.balancesStatus, 'rate_limited');
    const cachedAero = response.body.tokens.find((t: { symbol: string }) => t.symbol === 'AERO');
    assert.ok(cachedAero);
    assert.strictEqual(cachedAero.balanceFormatted, '2.5000');
    assert.strictEqual(cachedAero.dataFreshness, 'cached');
    assert.strictEqual(response.body.analysis.totalTokens, 2);
    const moralisCalls = mockFetch.mock.calls.filter((c: any) => String(c.arguments[0]).includes('moralis.io')).length;
    assert.strictEqual(moralisCalls, 0);

    restoreEnv('TOKEN_BALANCES_PROVIDER', origBalances);
    restoreEnv('TOKEN_BALANCES_FALLBACK_PROVIDER', origFallback);
    restoreEnv('PRICE_PROVIDER', origPrice);
    restoreEnv('TOKEN_SECURITY_PROVIDER', origSecurity);
    restoreEnv('APPROVAL_PROVIDER', origApproval);
    restoreEnv('ALCHEMY_API_KEY', origAlchemyKey);
    restoreEnv('MORALIS_API_KEY', origMoralisKey);
    mock.restoreAll();
  });
});
