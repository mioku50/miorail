import test, { describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { app } from '../app';
import { clearTokenSecurityCacheForTests } from '@mioagent/data-providers';
import { clearTokenBalancesCacheForTests } from '../lib/portfolioAnalysis';

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
    process.env.TOKEN_SECURITY_PROVIDER = 'none';
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
    assert.strictEqual(response.body.providers.risk, 'missing');
    assert.strictEqual(response.body.providers.riskProvider, 'none');

    mock.restoreAll();
  });

  test('GET /api/portfolio returns ERC-20 balances when provider is configured to mock', async () => {
    process.env.TOKEN_BALANCES_PROVIDER = 'mock';
    process.env.TOKEN_SECURITY_PROVIDER = 'none';
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
    process.env.TOKEN_SECURITY_PROVIDER = 'none';
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
    process.env.TOKEN_SECURITY_PROVIDER = 'none';
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
});

