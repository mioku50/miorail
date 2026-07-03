import { test, suite, mock, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  NoneApprovalProvider,
  MoralisApprovalProvider,
  getApprovalProviderFromEnv,
  MockApprovalProvider
} from '../src/index.js';

suite('Approval Providers', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    mock.restoreAll();
  });

  test('NoneApprovalProvider returns empty list', async () => {
    const provider = new NoneApprovalProvider();
    const res = await provider.getTokenApprovals({ walletAddress: '0x123', chainId: 8453 });
    assert.deepStrictEqual(res, []);
  });

  test('MockApprovalProvider returns mock approvals', async () => {
    const provider = new MockApprovalProvider();
    const res = await provider.getTokenApprovals({ walletAddress: '0x123', chainId: 8453 });
    assert.strictEqual(res.length, 2);
    assert.strictEqual(res[0].tokenSymbol, 'USDC');
    assert.strictEqual(res[0].isUnlimited, true);
  });

  test('MoralisApprovalProvider calls correct endpoint and formats allowances', async () => {
    const mockFetch = mock.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          result: [
            {
              token: { address: '0x111', symbol: 'TEST', name: 'Test Token', decimals: '18' },
              spender: { address: '0x222', label: 'Spender App' },
              value: '115792089237316195423570985008687907853269984665640564039457584007913129639935',
              value_formatted: 'Unlimited',
              block_timestamp: '2024-01-01'
            },
            {
              token_address: '0x333',
              symbol: 'SMALL',
              name: 'Small Token',
              decimals: '6',
              spender_address: '0x444',
              value: '5000000',
              value_formatted: '5.0000'
            }
          ]
        })
      } as Response;
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const provider = new MoralisApprovalProvider('test-api-key');
    const res = await provider.getTokenApprovals({ walletAddress: '0xabc', chainId: 8453 });

    assert.strictEqual(res.length, 2);
    assert.strictEqual(res[0].isUnlimited, true);
    assert.strictEqual(res[0].allowanceFormatted, 'Unlimited');
    assert.strictEqual(res[0].spenderLabel, 'Spender App');
    assert.strictEqual(res[1].isUnlimited, false);
    assert.strictEqual(res[1].allowanceFormatted, '5.0000');
    assert.strictEqual(mockFetch.mock.calls.length, 1);
    assert.strictEqual(mockFetch.mock.calls[0].arguments[0], 'https://deep-index.moralis.io/api/v2.2/wallets/0xabc/approvals?chain=base');
  });

  test('getApprovalProviderFromEnv returns none by default', () => {
    delete process.env.APPROVAL_PROVIDER;
    delete process.env.MORALIS_API_KEY;
    const { provider, status, statusCode, providerName } = getApprovalProviderFromEnv();
    assert.strictEqual(providerName, 'none');
    assert.strictEqual(statusCode, 'missing');
    assert.ok(provider instanceof NoneApprovalProvider);
  });

  test('getApprovalProviderFromEnv reports disabled when APPROVAL_PROVIDER=none (explicit)', () => {
    process.env.APPROVAL_PROVIDER = 'none';
    const { statusCode, providerName } = getApprovalProviderFromEnv();
    assert.strictEqual(providerName, 'none');
    assert.strictEqual(statusCode, 'disabled');
    delete process.env.APPROVAL_PROVIDER;
  });

  test('getApprovalProviderFromEnv returns mock when APPROVAL_PROVIDER=mock', () => {
    process.env.APPROVAL_PROVIDER = 'mock';
    const { provider, statusCode, providerName } = getApprovalProviderFromEnv();
    assert.strictEqual(providerName, 'mock');
    assert.strictEqual(statusCode, 'connected');
    assert.ok(provider instanceof MockApprovalProvider);
  });

  test('getApprovalProviderFromEnv returns moralis when APPROVAL_PROVIDER=moralis and key set', () => {
    process.env.APPROVAL_PROVIDER = 'moralis';
    process.env.MORALIS_API_KEY = 'key-123';
    const { provider, statusCode, providerName } = getApprovalProviderFromEnv();
    assert.strictEqual(providerName, 'moralis');
    assert.strictEqual(statusCode, 'connected');
    assert.ok(provider instanceof MoralisApprovalProvider);
  });
});
