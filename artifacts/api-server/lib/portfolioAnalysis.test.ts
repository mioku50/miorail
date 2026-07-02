import test, { describe } from 'node:test';
import assert from 'node:assert';
import { analyzePortfolioForRisk, buildRecommendationMetadataFromAnalysis, fetchInternalPortfolio, type PortfolioData } from './portfolioAnalysis.js';

describe('Portfolio Risk Analysis Utility', () => {
  test('analyzePortfolioForRisk flags spam token as high risk', () => {
    const mockPortfolio: PortfolioData = {
      totalUsdValue: '100.00',
      updatedAt: new Date().toISOString(),
      providerStatus: 'connected',
      providers: {
        rpc: 'connected',
        tokenBalances: 'connected',
        tokenBalancesProvider: 'moralis',
        prices: 'connected',
        risk: 'connected'
      },
      tokens: [
        {
          symbol: 'SPAM.com',
          name: 'Visit spam.com to claim 10000 USD',
          address: '0x1111111111111111111111111111111111111111',
          balance: '1000000000000000000000000',
          balanceFormatted: '1000000.0000',
          possibleSpam: true,
          verified: false
        }
      ]
    };

    const analysis = analyzePortfolioForRisk(mockPortfolio, '0x123', 'mainnet-readonly');
    assert.strictEqual(analysis.tokenFindings.length, 1);
    assert.strictEqual(analysis.tokenFindings[0].risk, 'high');
    assert.strictEqual(analysis.tokenFindings[0].suggestedHandling, 'ignore');
    assert.strictEqual(analysis.portfolioSnapshot.suspiciousTokenCount, 1);
    assert.strictEqual(analysis.portfolioSnapshot.provider, 'moralis');
    assert.match(analysis.summary, /Detected 1 low-confidence or suspicious tokens/);
  });

  test('analyzePortfolioForRisk flags verified stable token as low risk', () => {
    const mockPortfolio: PortfolioData = {
      totalUsdValue: '500.00',
      updatedAt: new Date().toISOString(),
      providerStatus: 'connected',
      providers: {
        rpc: 'connected',
        tokenBalances: 'connected',
        tokenBalancesProvider: 'moralis',
        prices: 'connected',
        risk: 'connected'
      },
      tokens: [
        {
          symbol: 'USDC',
          name: 'USD Coin',
          address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
          balance: '500000000',
          balanceFormatted: '500.0000',
          usdValue: '500.00',
          verified: true,
          possibleSpam: false
        }
      ]
    };

    const analysis = analyzePortfolioForRisk(mockPortfolio, '0x123', 'mainnet-readonly');
    assert.strictEqual(analysis.tokenFindings.length, 1);
    assert.strictEqual(analysis.tokenFindings[0].risk, 'low');
    assert.strictEqual(analysis.tokenFindings[0].suggestedHandling, 'keep-watchlist');
    assert.strictEqual(analysis.portfolioSnapshot.suspiciousTokenCount, 0);
  });

  test('analyzePortfolioForRisk caps token findings to maximum 10', () => {
    const tokens = [];
    for (let i = 0; i < 15; i++) {
      tokens.push({
        symbol: `TKN${i}`,
        name: `Token ${i}`,
        address: `0x00000000000000000000000000000000000000${i.toString(16).padStart(2, '0')}`,
        balance: '100',
        balanceFormatted: '100.0000',
        verified: false,
        usdValue: '0.00'
      });
    }

    const mockPortfolio: PortfolioData = {
      totalUsdValue: '0.00',
      updatedAt: new Date().toISOString(),
      providerStatus: 'connected',
      providers: {
        rpc: 'connected',
        tokenBalances: 'connected',
        tokenBalancesProvider: 'moralis',
        prices: 'connected',
        risk: 'connected'
      },
      tokens
    };

    const analysis = analyzePortfolioForRisk(mockPortfolio, '0x123', 'mainnet-readonly');
    assert.strictEqual(analysis.portfolioSnapshot.tokenCount, 15);
    assert.strictEqual(analysis.tokenFindings.length, 10);
  });

  test('analyzePortfolioForRisk ranks findings by USD value within same risk tier', () => {
    const mockPortfolio: PortfolioData = {
      totalUsdValue: '1500.00',
      updatedAt: new Date().toISOString(),
      providerStatus: 'connected',
      providers: {
        rpc: 'connected',
        tokenBalances: 'connected',
        tokenBalancesProvider: 'moralis',
        prices: 'connected',
        priceProvider: 'coingecko',
        risk: 'connected'
      },
      tokens: [
        {
          symbol: 'SMALL',
          name: 'Small Coin',
          address: '0x1000000000000000000000000000000000000001',
          balance: '10000000000000000000',
          balanceFormatted: '10.0000',
          usdValue: '10.00',
          verified: true,
          possibleSpam: false
        },
        {
          symbol: 'LARGE',
          name: 'Large Coin',
          address: '0x2000000000000000000000000000000000000002',
          balance: '1000000000000000000000',
          balanceFormatted: '1000.0000',
          usdValue: '1490.00',
          verified: true,
          possibleSpam: false
        }
      ]
    };

    const analysis = analyzePortfolioForRisk(mockPortfolio, '0x123', 'mainnet-readonly');
    assert.strictEqual(analysis.tokenFindings.length, 2);
    assert.strictEqual(analysis.tokenFindings[0].symbol, 'LARGE');
    assert.strictEqual(analysis.tokenFindings[1].symbol, 'SMALL');
  });

  test('fetchInternalPortfolio computes USD values when mock price provider is configured', async () => {
    const origPriceProvider = process.env.PRICE_PROVIDER;
    const origBalancesProvider = process.env.TOKEN_BALANCES_PROVIDER;
    process.env.PRICE_PROVIDER = 'mock';
    process.env.TOKEN_BALANCES_PROVIDER = 'mock';

    try {
      const portfolio = await fetchInternalPortfolio('0x123', 'sepolia');
      assert.strictEqual(portfolio.providers?.priceProvider, 'mock');
      assert.ok(portfolio.totalUsdValue);
      assert.ok(Number(portfolio.totalUsdValue) > 0);
    } finally {
      process.env.PRICE_PROVIDER = origPriceProvider;
      process.env.TOKEN_BALANCES_PROVIDER = origBalancesProvider;
    }
  });

  test('buildRecommendationMetadataFromAnalysis creates complete metadata with blocked safetyState', () => {
    const mockAnalysis = {
      summary: 'Detected 1 suspicious tokens',
      portfolioSnapshot: {
        walletAddress: '0x123',
        chain: 'base-mainnet',
        tokenCount: 2,
        visibleTokenCount: 2,
        suspiciousTokenCount: 1,
        provider: 'moralis',
        priceProvider: 'coingecko',
        totalUsdValue: '100.00',
        pricedTokenCount: 1,
        unpricedTokenCount: 1
      },
      tokenFindings: [],
      suggestedNextSteps: ['Monitor']
    };

    const meta = buildRecommendationMetadataFromAnalysis({
      intent: { title: 'Risk Review', reason: 'User asked' },
      message: 'check my tokens',
      walletAddress: '0x123',
      chainEnv: 'mainnet-readonly',
      analysis: mockAnalysis
    });

    assert.strictEqual(meta.type, 'recommendation');
    assert.strictEqual(meta.chainMode, 'mainnet-readonly');
    assert.strictEqual(meta.safetyState, 'blocked');
    assert.strictEqual(meta.executionStatus, 'read-only');
    assert.deepStrictEqual(meta.analysis, mockAnalysis);
  });
});

