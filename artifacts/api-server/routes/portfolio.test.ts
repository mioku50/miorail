import test, { describe, mock } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { app } from '../app';

describe('Portfolio API', () => {
  test('GET /api/portfolio returns 400 when address is missing', async () => {
    const response = await request(app).get('/api/portfolio');
    assert.strictEqual(response.status, 400);
    assert.strictEqual(response.body.error, 'Wallet address not configured');
  });

  test('GET /api/portfolio returns ETH balance and token status when address is provided', async () => {
    process.env.TOKEN_BALANCES_PROVIDER = 'none';
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

    mock.restoreAll();
  });

  test('GET /api/portfolio returns ERC-20 balances when provider is configured to mock', async () => {
    process.env.TOKEN_BALANCES_PROVIDER = 'mock';
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

    const response = await request(app).get('/api/portfolio?address=0x1234567890123456789012345678901234567890');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.tokens.length, 1);
    assert.strictEqual(response.body.tokens[0].symbol, 'ETH');
    assert.strictEqual(response.body.providerStatus, 'Token balances provider failed. Showing native ETH only.');
    assert.strictEqual(response.body.providers.tokenBalances, 'failed');

    mock.restoreAll();
  });

  test('GET /api/portfolio returns Moralis connected status and includes suspicious tokens', async () => {
    process.env.TOKEN_BALANCES_PROVIDER = 'moralis';
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
});

