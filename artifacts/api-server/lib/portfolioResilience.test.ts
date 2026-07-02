import test, { describe } from 'node:test';
import assert from 'node:assert';
import { 
  analyzePortfolioForRisk, 
  buildRecommendationMetadataFromAnalysis, 
  fetchInternalPortfolio, 
  setTokenBalancesCacheForTests,
  clearTokenBalancesCacheForTests,
  type PortfolioData 
} from './portfolioAnalysis.js';

describe('Portfolio Resilience and Stale Cache Tests', () => {
  test('if price provider fails, token balances still appear and warning is included', () => {
    const mockPortfolio: PortfolioData = {
      totalUsdValue: undefined,
      updatedAt: new Date().toISOString(),
      providerStatus: 'Price provider failed',
      providers: {
        rpc: 'connected',
        tokenBalances: 'connected',
        tokenBalancesProvider: 'moralis',
        prices: 'failed',
        priceProvider: 'failed',
        risk: 'connected',
        riskProvider: 'goplus'
      },
      tokens: [
        {
          symbol: 'ETH',
          name: 'Ethereum',
          address: 'native',
          balance: '1000000000000000000',
          balanceFormatted: '1.0000',
          verified: true
        },
        {
          symbol: 'AERO',
          name: 'Aerodrome',
          address: '0x940181a94a35a4569e4529a3cdfb74e3e2010f32',
          balance: '500000000000000000000',
          balanceFormatted: '500.0000',
          verified: true
        }
      ]
    };

    const analysis = analyzePortfolioForRisk(mockPortfolio, '0x123', 'mainnet-readonly');
    assert.strictEqual(analysis.portfolioSnapshot.tokenCount, 2);
    assert.strictEqual(analysis.portfolioSnapshot.provider, 'moralis');
    assert.strictEqual(analysis.portfolioSnapshot.priceProvider, 'failed');
    assert.ok(analysis.suggestedNextSteps.some(step => step.includes('USD values unavailable; value ranking limited')));
  });

  test('if GoPlus checks 0 ERC-20 tokens, security status downgrades to failed while token balances remain', () => {
    const mockPortfolio: PortfolioData = {
      totalUsdValue: '1000.00',
      updatedAt: new Date().toISOString(),
      providerStatus: 'connected',
      providers: {
        rpc: 'connected',
        tokenBalances: 'connected',
        tokenBalancesProvider: 'moralis',
        prices: 'connected',
        priceProvider: 'coingecko',
        risk: 'connected',
        riskProvider: 'goplus'
      },
      tokens: [
        {
          symbol: 'ETH',
          name: 'Ethereum',
          address: 'native',
          balance: '1000000000000000000',
          balanceFormatted: '1.0000',
          usdValue: '1000.00',
          verified: true
        },
        {
          symbol: 'USDC',
          name: 'USD Coin',
          address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
          balance: '1000000',
          balanceFormatted: '1.0000',
          verified: true
        }
      ]
    };

    const analysis = analyzePortfolioForRisk(mockPortfolio, '0x123', 'mainnet-readonly');
    assert.strictEqual(analysis.portfolioSnapshot.tokenCount, 2);
    assert.strictEqual(analysis.securityProvider.status, 'failed');
    assert.ok(analysis.suggestedNextSteps.some(step => step.includes('Security scan did not return token-level results')));
  });

  test('if live provider fails on subsequent refresh, cached token balances return with stale status', async () => {
    clearTokenBalancesCacheForTests();
    const testAddress = '0x1111111111111111111111111111111111111111';
    const cachedTokens = [
      {
        symbol: 'AERO',
        name: 'Aerodrome',
        address: '0x940181a94a35a4569e4529a3cdfb74e3e2010f32',
        balance: '500000000000000000000',
        balanceFormatted: '500.0000',
        verified: true,
        dataFreshness: 'cached' as const
      }
    ];

    setTokenBalancesCacheForTests(8453, testAddress, cachedTokens);

    const oldProvider = process.env.TOKEN_BALANCES_PROVIDER;
    const oldKey = process.env.MORALIS_API_KEY;
    try {
      process.env.TOKEN_BALANCES_PROVIDER = 'moralis';
      process.env.MORALIS_API_KEY = 'invalid_key_for_test'; // Force live fetch failure

      const portfolio = await fetchInternalPortfolio(testAddress, 'mainnet');
      assert.strictEqual(portfolio.providers?.tokenBalances, 'stale');
      assert.strictEqual(portfolio.providers?.tokenBalancesProvider, 'moralis');
      assert.ok(portfolio.tokens.length >= 2); // ETH + cached AERO
      assert.strictEqual(portfolio.tokens[0].dataFreshness, 'cached');
      
      const aero = portfolio.tokens.find(t => t.symbol === 'AERO');
      assert.ok(aero);
      assert.strictEqual(aero?.dataFreshness, 'cached');
    } finally {
      if (oldProvider === undefined) {
        delete process.env.TOKEN_BALANCES_PROVIDER;
      } else {
        process.env.TOKEN_BALANCES_PROVIDER = oldProvider;
      }
      if (oldKey === undefined) {
        delete process.env.MORALIS_API_KEY;
      } else {
        process.env.MORALIS_API_KEY = oldKey;
      }
      clearTokenBalancesCacheForTests();
    }
  });

  test('recommendation cards reflect precise provider statuses and include warning steps', () => {
    const mockPortfolio: PortfolioData = {
      totalUsdValue: '500.00',
      updatedAt: new Date().toISOString(),
      providerStatus: 'Using cached token balances',
      providers: {
        rpc: 'connected',
        tokenBalances: 'stale',
        tokenBalancesProvider: 'moralis',
        prices: 'failed',
        priceProvider: 'failed',
        risk: 'partial',
        riskProvider: 'goplus'
      },
      tokens: [
        {
          symbol: 'USDC',
          name: 'USD Coin',
          address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
          balance: '500000000',
          balanceFormatted: '500.0000',
          verified: true
        }
      ]
    };

    const analysis = analyzePortfolioForRisk(mockPortfolio, '0x123', 'mainnet-readonly');
    assert.strictEqual(analysis.portfolioSnapshot.provider, 'moralis');
    assert.strictEqual(analysis.portfolioSnapshot.priceProvider, 'failed');
    assert.strictEqual(analysis.securityProvider.status, 'partial');
    assert.ok(analysis.suggestedNextSteps.some(step => step.includes('Analysis used cached Moralis token balances')));

    const meta = buildRecommendationMetadataFromAnalysis({
      intent: { title: 'Risk Check', reason: 'Test' },
      message: 'check portfolio',
      walletAddress: '0x123',
      chainEnv: 'mainnet-readonly',
      analysis
    });

    assert.strictEqual(meta.analysis?.portfolioSnapshot.provider, 'moralis');
    assert.strictEqual(meta.analysis?.securityProvider.status, 'partial');
  });

  test('no executable mainnet payload is generated in read-only mode', () => {
    const mockPortfolio: PortfolioData = {
      totalUsdValue: '100.00',
      updatedAt: new Date().toISOString(),
      providerStatus: 'connected',
      providers: {
        rpc: 'connected',
        tokenBalances: 'connected',
        tokenBalancesProvider: 'moralis',
        prices: 'connected',
        priceProvider: 'coingecko',
        risk: 'connected',
        riskProvider: 'goplus'
      },
      tokens: []
    };

    const analysis = analyzePortfolioForRisk(mockPortfolio, '0x123', 'mainnet-readonly');
    const meta = buildRecommendationMetadataFromAnalysis({
      intent: { title: 'Rebalance', reason: 'Test' },
      message: 'rebalance portfolio',
      walletAddress: '0x123',
      chainEnv: 'mainnet-readonly',
      analysis
    });

    assert.strictEqual(meta.chainMode, 'mainnet-readonly');
    assert.strictEqual(meta.safetyState, 'blocked');
    assert.strictEqual(meta.executionStatus, 'read-only');
    assert.deepStrictEqual(meta.calls, []);
  });
});
