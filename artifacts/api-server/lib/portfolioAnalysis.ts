import { getTokenBalancesProviderFromEnv } from '@mioagent/data-providers';

export interface TokenInfo {
  symbol: string;
  name?: string;
  address: string;
  balance: string;
  balanceFormatted: string;
  decimals?: number;
  usdValue?: string;
  logoUrl?: string;
  verified?: boolean;
  possibleSpam?: boolean;
}

export interface PortfolioData {
  totalUsdValue: string;
  tokens: TokenInfo[];
  updatedAt: string;
  providerStatus: string;
  providers: {
    rpc: string;
    tokenBalances: string;
    tokenBalancesProvider: string;
    prices: string;
    risk: string;
  };
}

export interface TokenFinding {
  symbol: string;
  name?: string;
  address?: string;
  balanceFormatted?: string;
  risk: "low" | "medium" | "high" | "unknown";
  reason: string;
  suggestedHandling: "monitor" | "ignore" | "verify" | "review-permissions" | "keep-watchlist";
}

export interface PortfolioRiskAnalysis {
  summary: string;
  portfolioSnapshot: {
    walletAddress: string;
    chain: string;
    tokenCount: number;
    visibleTokenCount: number;
    suspiciousTokenCount: number;
    provider: string;
    providerStatus?: string;
  };
  tokenFindings: TokenFinding[];
  suggestedNextSteps: string[];
}

export async function fetchInternalPortfolio(address: string, chainEnv: string = 'sepolia'): Promise<PortfolioData> {
  const chainId = chainEnv === 'sepolia' ? 84532 : 8453;
  let balanceFormatted = '0.0000';
  let balance = '0';

  let rpcStatus: "connected" | "missing" | "failed" = "connected";
  const rpcUrl = chainEnv === 'sepolia' ? process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org' : process.env.BASE_MAINNET_RPC_URL || 'https://mainnet.base.org';

  try {
    const fetchRes = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getBalance',
        params: [address, 'latest']
      })
    });
    const data = await fetchRes.json();
    if (!data.error && data.result) {
      balance = BigInt(data.result).toString();
      balanceFormatted = (Number(balance) / 1e18).toFixed(4);
    } else {
      rpcStatus = "failed";
    }
  } catch {
    rpcStatus = "failed";
  }

  const tokens: TokenInfo[] = [
    {
      symbol: 'ETH',
      name: 'Ethereum',
      address: 'native',
      balance,
      balanceFormatted,
      usdValue: '0.00',
      verified: true,
      possibleSpam: false,
    }
  ];

  const { provider, status, providerName } = getTokenBalancesProviderFromEnv();
  let providerStatus = status;
  let tokenBalancesStatus: "connected" | "missing" | "failed" = providerName === "none" ? "missing" : "connected";

  if (provider && providerName !== 'none') {
    try {
      const erc20Balances = await provider.getTokenBalances({ address, chainId });
      for (const tb of erc20Balances) {
        tokens.push({
          symbol: tb.symbol,
          name: tb.name || tb.symbol,
          address: tb.address,
          balance: tb.balance,
          balanceFormatted: tb.balanceFormatted,
          decimals: tb.decimals,
          usdValue: tb.usdValue || '0.00',
          logoUrl: tb.logoUrl,
          verified: tb.verified,
          possibleSpam: tb.possibleSpam,
        });
      }
      if (tokens.length === 1 && (providerName === 'moralis' || providerName === 'alchemy')) {
        providerStatus = 'No ERC-20 tokens found for this wallet';
      }
    } catch {
      providerStatus = 'Token balances provider failed. Showing native ETH only.';
      tokenBalancesStatus = 'failed';
    }
  }

  let totalUsd = 0;
  for (const t of tokens) {
    if (t.usdValue && !isNaN(Number(t.usdValue))) {
      totalUsd += Number(t.usdValue);
    }
  }

  const pricesStatus: "connected" | "missing" | "failed" = process.env.COINGECKO_API_KEY || process.env.PRICE_PROVIDER ? "connected" : "missing";
  const riskStatus: "connected" | "missing" | "failed" = process.env.GOPLUS_API_KEY || process.env.RISK_PROVIDER ? "connected" : "missing";

  return {
    totalUsdValue: totalUsd.toFixed(2),
    tokens,
    updatedAt: new Date().toISOString(),
    providerStatus,
    providers: {
      rpc: rpcStatus,
      tokenBalances: tokenBalancesStatus,
      tokenBalancesProvider: providerName,
      prices: pricesStatus,
      risk: riskStatus,
    }
  };
}

export function analyzePortfolioForRisk(
  portfolio: PortfolioData,
  walletAddress: string,
  chainEnv: string = 'mainnet-readonly'
): PortfolioRiskAnalysis {
  const findings: TokenFinding[] = [];
  const tokens = portfolio.tokens || [];

  for (const t of tokens) {
    const isNative = t.address === 'native' || (t.symbol === 'ETH' && t.address === 'native');
    const isKnownStable = ['USDC', 'DAI', 'USDT', 'WETH', 'CBETH', 'EURC', 'AERO', 'DEGEN'].includes(t.symbol.toUpperCase());
    const hasSuspiciousRegex = /\.(com|org|io|net|xyz|gg|app|me|site|store|online|tech|info)|(http:|https:|www\.|claim|airdrop|gift|bonus|visit|reward|free|voucher)/i.test(`${t.symbol} ${t.name || ''}`);
    const numBalance = Number(t.balanceFormatted || '0');
    const noPrice = !t.usdValue || t.usdValue === '0.00' || t.usdValue === '0';

    let risk: "low" | "medium" | "high" | "unknown" = "unknown";
    let reason = "Insufficient metadata to evaluate token risk.";
    let suggestedHandling: TokenFinding["suggestedHandling"] = "verify";

    if (isNative) {
      risk = "low";
      reason = "Native Ethereum base asset on Base network.";
      suggestedHandling = "monitor";
    } else if (t.possibleSpam || hasSuspiciousRegex || (numBalance > 100000 && noPrice && !t.verified && !t.logoUrl)) {
      risk = "high";
      if (t.possibleSpam) {
        reason = "Flagged as possible spam or scam asset by token provider.";
        suggestedHandling = "ignore";
      } else if (hasSuspiciousRegex) {
        reason = "Symbol or name contains suspicious URL or claim keyword.";
        suggestedHandling = "ignore";
      } else {
        reason = "Large unexplained balance with no price or verification metadata.";
        suggestedHandling = "review-permissions";
      }
    } else if (isKnownStable && (t.verified || !t.possibleSpam)) {
      risk = "low";
      reason = "Verified well-known token on Base network.";
      suggestedHandling = "keep-watchlist";
    } else if (noPrice && !t.verified) {
      risk = "medium";
      reason = "Unverified token with missing price or logo metadata.";
      suggestedHandling = "verify";
    } else if (!t.logoUrl && (!t.name || t.symbol.length > 10)) {
      risk = "medium";
      reason = "Token lacks logo and standard identification metadata.";
      suggestedHandling = "verify";
    } else if (t.verified || !noPrice) {
      risk = "low";
      reason = "Token has price metadata and no suspicious indicators.";
      suggestedHandling = "monitor";
    }

    findings.push({
      symbol: t.symbol,
      name: t.name,
      address: t.address,
      balanceFormatted: t.balanceFormatted,
      risk,
      reason,
      suggestedHandling
    });
  }

  const riskOrder: Record<string, number> = { high: 0, medium: 1, unknown: 2, low: 3 };
  findings.sort((a, b) => (riskOrder[a.risk] ?? 4) - (riskOrder[b.risk] ?? 4));

  const suspiciousTokens = findings.filter(f => f.risk === 'high' || f.risk === 'medium');
  const suspiciousTokenCount = suspiciousTokens.length;
  const tokenCount = tokens.length;
  const visibleTokenCount = tokens.length;
  const provider = portfolio.providers?.tokenBalancesProvider || "none";
  const chain = (chainEnv === 'mainnet-readonly' || chainEnv === 'mainnet') ? "base-mainnet" : "base-sepolia";

  let summary: string;
  if (suspiciousTokenCount > 0) {
    summary = `Detected ${suspiciousTokenCount} low-confidence or suspicious tokens out of ${tokenCount} assets. Most appear to be unverified or spam assets. No execution is possible in read-only mode.`;
  } else {
    summary = `Reviewed ${tokenCount} Base portfolio assets. All tokens appear low-risk or verified with no suspicious indicators. No execution is possible in read-only mode.`;
  }

  const suggestedNextSteps = [
    "Review permissions and consider ignoring high-risk or unverified tokens in your wallet interface.",
    "Do not visit web URLs or claim links found in token symbols or names.",
    "Verify token contract addresses on BaseScan before interacting or approving spend permissions."
  ];

  return {
    summary,
    portfolioSnapshot: {
      walletAddress,
      chain,
      tokenCount,
      visibleTokenCount,
      suspiciousTokenCount,
      provider,
      providerStatus: portfolio.providerStatus
    },
    tokenFindings: findings.slice(0, 10),
    suggestedNextSteps
  };
}

export function buildRecommendationMetadataFromAnalysis(input: {
  intent?: any;
  message: string;
  walletAddress: string;
  chainEnv: string;
  analysis: PortfolioRiskAnalysis;
  providerContext?: any;
}) {
  const { intent, message, walletAddress, chainEnv, analysis, providerContext } = input;
  const isReadonly = chainEnv === 'mainnet-readonly';
  const isMainnetExecEnabled = process.env.MAINNET_EXECUTION_ENABLED === 'true';
  const canExecute = !isReadonly && (chainEnv !== 'mainnet' || isMainnetExecEnabled);

  const overallRisk = analysis.portfolioSnapshot.suspiciousTokenCount > 0 ? "high" : "low";

  return {
    type: "recommendation",
    title: intent?.title || "Token Risk & Portfolio Review",
    instruction: message,
    reason: intent?.reason || `Automated risk analysis created by Agent Stream for: "${message}"`,
    expectedEffect: intent?.expectedEffect || "Analyze Base token list, filter spam/airdrop tokens, and flag any high-risk assets.",
    risk: isReadonly ? (analysis.portfolioSnapshot.suspiciousTokenCount > 0 ? "medium" : "low") : overallRisk,
    riskScore: analysis.portfolioSnapshot.suspiciousTokenCount > 0 ? 75 : 15,
    chainMode: chainEnv,
    safetyState: isReadonly ? "blocked" : (canExecute ? "executable" : "blocked"),
    executable: canExecute,
    executionStatus: isReadonly ? "read-only" : (canExecute ? "executable" : "blocked"),
    createdBy: intent?.createdBy || "agent-stream",
    walletAddress: walletAddress,
    providerContext: providerContext || {
      tokenBalances: analysis.portfolioSnapshot.provider,
      prices: "missing",
      risk: "missing"
    },
    analysis: analysis
  };
}
