import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { analyzePortfolioForRisk, buildRecommendationMetadataFromAnalysis, fetchInternalPortfolio, clearTokenBalancesCacheForTests, type PortfolioData, type PortfolioRiskAnalysis } from './portfolioAnalysis.js';

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe('Portfolio Risk Analysis Utility', () => {
  beforeEach(() => {
    // Force an in-memory orchestrator so unit tests stay hermetic (no DB writes).
    clearTokenBalancesCacheForTests();
  });
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
    const origSecurityProvider = process.env.TOKEN_SECURITY_PROVIDER;
    const origApprovalProvider = process.env.APPROVAL_PROVIDER;
    process.env.PRICE_PROVIDER = 'mock';
    process.env.TOKEN_BALANCES_PROVIDER = 'mock';
    process.env.TOKEN_SECURITY_PROVIDER = 'none';
    process.env.APPROVAL_PROVIDER = 'none';

    try {
      const portfolio = await fetchInternalPortfolio('0x123', 'sepolia');
      assert.strictEqual(portfolio.providers?.priceProvider, 'mock');
      assert.strictEqual(portfolio.providers?.risk, 'disabled');
      assert.ok(portfolio.totalUsdValue);
      assert.ok(Number(portfolio.totalUsdValue) > 0);
      // T11.6: portfolio exposes cache/freshness diagnostics.
      assert.strictEqual(portfolio.dataFreshness, 'live');
      assert.strictEqual(portfolio.providerCallsMade, 2); // balances + prices
      assert.ok(portfolio.providerBudgetStatus);
      assert.strictEqual(portfolio.providerBudgetStatus?.exhausted, false);
    } finally {
      restoreEnv('PRICE_PROVIDER', origPriceProvider);
      restoreEnv('TOKEN_BALANCES_PROVIDER', origBalancesProvider);
      restoreEnv('TOKEN_SECURITY_PROVIDER', origSecurityProvider);
      restoreEnv('APPROVAL_PROVIDER', origApprovalProvider);
    }
  });

  test('analyzePortfolioForRisk surfaces cache freshness fields in portfolioSnapshot', () => {
    const mockPortfolio: PortfolioData = {
      totalUsdValue: '100.00',
      updatedAt: new Date().toISOString(),
      providerStatus: 'connected',
      dataFreshness: 'cached',
      cacheAgeSeconds: 42,
      providerBudgetStatus: { exhausted: false, providers: [] },
      providerCallsMade: 0,
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
          verified: true
        }
      ]
    };

    const analysis = analyzePortfolioForRisk(mockPortfolio, '0x123', 'mainnet-readonly');
    assert.strictEqual(analysis.portfolioSnapshot.dataFreshness, 'cached');
    assert.strictEqual(analysis.portfolioSnapshot.cacheAgeSeconds, 42);
    assert.strictEqual(analysis.portfolioSnapshot.providerCallsMade, 0);
    assert.strictEqual(analysis.portfolioSnapshot.providerBudgetStatus?.exhausted, false);
    assert.strictEqual(analysis.portfolioSnapshot.snapshotTimestamp, mockPortfolio.updatedAt);

    const meta = buildRecommendationMetadataFromAnalysis({
      message: 'check portfolio',
      walletAddress: '0x123',
      chainEnv: 'mainnet-readonly',
      analysis
    });
    assert.strictEqual(meta.analysis?.portfolioSnapshot.dataFreshness, 'cached');
    assert.strictEqual(meta.analysis?.portfolioSnapshot.cacheAgeSeconds, 42);
    assert.strictEqual(meta.analysis?.portfolioSnapshot.snapshotTimestamp, mockPortfolio.updatedAt);
    assert.deepStrictEqual(meta.calls, []);
  });


  test('analyzePortfolioForRisk upgrades honeypot token to high risk', () => {
    const mockPortfolio: PortfolioData = {
      updatedAt: new Date().toISOString(),
      providerStatus: 'connected',
      providers: {
        rpc: 'connected',
        tokenBalances: 'connected',
        tokenBalancesProvider: 'moralis',
        prices: 'missing',
        risk: 'connected',
        riskProvider: 'goplus'
      },
      tokens: [
        {
          symbol: 'RUG',
          name: 'Rug Token',
          address: '0x9999999999999999999999999999999999999999',
          balance: '1000000000000000000',
          balanceFormatted: '1.0000',
          verified: false,
          security: {
            provider: 'goplus',
            status: 'high-risk',
            summary: 'GoPlus reported high-risk contract flags: Honeypot-like behavior.',
            riskLabels: ['Honeypot-like behavior'],
            flags: { isHoneypot: true, hasBlacklist: true }
          }
        }
      ]
    };

    const analysis = analyzePortfolioForRisk(mockPortfolio, '0x123', 'mainnet-readonly');
    assert.strictEqual(analysis.tokenFindings[0].risk, 'high');
    assert.strictEqual(analysis.tokenFindings[0].security?.status, 'high-risk');
    assert.strictEqual(analysis.portfolioSnapshot.securityHighRiskCount, 1);
    assert.strictEqual(analysis.securityProvider.provider, 'goplus');
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
        unpricedTokenCount: 1,
        securityCheckedTokenCount: 1,
        securityHighRiskCount: 0,
        securityWarningCount: 0,
        securityProvider: 'goplus'
      },
      securityProvider: {
        provider: 'goplus',
        status: 'connected'
      },
      tokenFindings: [],
      suggestedNextSteps: ['Monitor']
    } satisfies PortfolioRiskAnalysis;

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

