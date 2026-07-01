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
});

