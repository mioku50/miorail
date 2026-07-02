import { getTokenBalancesProviderFromEnv, getPriceProviderFromEnv, getTokenSecurityProviderFromEnv, type TokenSecurityResult, type TokenSecurityFlags, type TokenSecurityProviderName, type TokenSecurityStatus } from '@mioagent/data-providers';

export interface TokenInfoSecurity {
  provider: TokenSecurityProviderName;
  status: TokenSecurityStatus;
  summary?: string;
  riskLabels?: string[];
  flags?: TokenSecurityFlags;
}

export interface TokenInfo {
  symbol: string;
  name?: string;
  address: string;
  balance: string;
  balanceFormatted: string;
  decimals?: number;
  usdValue?: string;
  usdPrice?: string;
  priceConfidence?: "high" | "medium" | "low" | "unknown";
  logoUrl?: string;
  verified?: boolean;
  possibleSpam?: boolean;
  security?: TokenInfoSecurity;
}

export interface PortfolioData {
  totalUsdValue?: string;
  tokens: TokenInfo[];
  updatedAt: string;
  providerStatus: string;
  providers: {
    rpc: string;
    tokenBalances: string;
    tokenBalancesProvider: string;
    prices: string;
    priceProvider?: string;
    risk: "connected" | "missing" | "failed";
    riskProvider?: TokenSecurityProviderName;
  };
}

export interface TokenFinding {
  symbol: string;
  name?: string;
  address?: string;
  balanceFormatted?: string;
  usdValue?: string;
  priceStatus?: string;
  risk: "low" | "medium" | "high" | "unknown";
  reason: string;
  suggestedHandling: "monitor" | "ignore" | "verify" | "review-permissions" | "keep-watchlist";
  security?: {
    provider: TokenSecurityProviderName;
    status: TokenSecurityStatus;
    labels: string[];
    summary: string;
    flags?: TokenSecurityFlags;
  };
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
    priceProvider?: string;
    totalUsdValue?: string;
    pricedTokenCount: number;
    unpricedTokenCount: number;
    providerStatus?: string;
    securityCheckedTokenCount: number;
    securityHighRiskCount: number;
    securityWarningCount: number;
    securityProvider: TokenSecurityProviderName;
  };
  securityProvider: {
    provider: TokenSecurityProviderName;
    status: "connected" | "missing" | "failed";
  };
  tokenFindings: TokenFinding[];
  suggestedNextSteps: string[];
}

function toPortfolioSecurity(result: TokenSecurityResult): TokenInfoSecurity {
  return {
    provider: result.provider,
    status: result.status,
    summary: result.summary,
    riskLabels: result.rawRiskLabels,
    flags: result.flags
  };
}

function isErc20Address(address?: string) {
  return !!address && /^0x[a-fA-F0-9]{40}$/.test(address);
}

function isTokenPriced(t: Pick<TokenInfo, 'usdValue' | 'usdPrice'>) {
  return !!((t.usdValue && !isNaN(Number(t.usdValue)) && Number(t.usdValue) > 0) || (t.usdValue === '0.00' && t.usdPrice) || (t.usdValue && t.usdValue !== '0.00'));
}

function prioritizeSecurityScanTokens(tokens: TokenInfo[]) {
  return [...tokens]
    .filter(t => isErc20Address(t.address))
    .sort((a, b) => {
      const aVal = a.usdValue && !isNaN(Number(a.usdValue)) ? Number(a.usdValue) : 0;
      const bVal = b.usdValue && !isNaN(Number(b.usdValue)) ? Number(b.usdValue) : 0;
      const aLowConfidence = a.possibleSpam || !a.verified || !a.logoUrl || !isTokenPriced(a);
      const bLowConfidence = b.possibleSpam || !b.verified || !b.logoUrl || !isTokenPriced(b);
      if (aVal !== bVal) return bVal - aVal;
      if (aLowConfidence !== bLowConfidence) return aLowConfidence ? -1 : 1;
      return Number(b.balanceFormatted || '0') - Number(a.balanceFormatted || '0');
    })
    .slice(0, 50);
}

function providerStatusToSecurityStatus(status: string): "connected" | "missing" | "failed" {
  if (status === 'failed') return 'failed';
  if (status === 'missing') return 'missing';
  return 'connected';
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
      usdValue: undefined,
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
          usdValue: tb.usdValue || undefined,
          usdPrice: tb.usdPrice || undefined,
          priceConfidence: tb.priceConfidence || undefined,
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

  const { provider: priceProvider, status: priceStatusText, providerName: priceProviderName } = getPriceProviderFromEnv();
  let pricesStatus: "connected" | "missing" | "failed" = priceProviderName === "none" ? "missing" : "connected";

  if (priceProvider && priceProviderName !== 'none') {
    try {
      const prices = await priceProvider.getTokenPrices({ chainId, tokens });
      const priceMap = new Map(prices.map(p => [(p.address || p.symbol).toLowerCase(), p]));
      for (const t of tokens) {
        const key = (t.address === 'native' || !t.address ? 'ETH' : t.address).toLowerCase();
        const p = priceMap.get(key) || priceMap.get(t.symbol.toLowerCase());
        if (p && p.usdPrice && !isNaN(Number(p.usdPrice))) {
          t.usdPrice = p.usdPrice;
          t.priceConfidence = p.confidence;
          const val = Number(t.balanceFormatted) * Number(p.usdPrice);
          t.usdValue = val.toFixed(2);
        } else if (!t.usdValue && !t.usdPrice) {
          t.usdPrice = undefined;
          t.usdValue = undefined;
          t.priceConfidence = "unknown";
        }
      }
    } catch (err) {
      pricesStatus = "failed";
      if (tokenBalancesStatus !== 'failed') {
        providerStatus = `Price provider (${priceProviderName}) failed to fetch prices. Showing token balances without USD values.`;
      }
    }
  } else {
    for (const t of tokens) {
      if (t.usdValue === '0.00' && !t.usdPrice) {
        t.usdValue = undefined;
      }
    }
  }

  let totalUsd = 0;
  let pricedCount = 0;
  for (const t of tokens) {
    if (t.usdValue && !isNaN(Number(t.usdValue))) {
      const val = Number(t.usdValue);
      if (val > 0 || t.usdPrice || t.balanceFormatted === '0.0000' || t.usdValue !== '0.00') {
        totalUsd += val;
        pricedCount++;
      }
    }
  }

  const totalUsdValue = pricedCount > 0 ? totalUsd.toFixed(2) : undefined;

  const { provider: tokenSecurityProvider, statusCode: initialRiskStatus, providerName: riskProviderName } = getTokenSecurityProviderFromEnv();
  let riskStatus: "connected" | "missing" | "failed" = initialRiskStatus;
  if (riskProviderName !== 'none') {
    const securityScanTokens = prioritizeSecurityScanTokens(tokens);
    if (securityScanTokens.length > 0) {
      try {
        const securityResults = await tokenSecurityProvider.getTokenSecurity({
          chainId,
          tokenAddresses: securityScanTokens.map(t => t.address)
        });
        const securityMap = new Map(securityResults.map(result => [result.address.toLowerCase(), result]));
        let hasFailure = false;
        for (const token of securityScanTokens) {
          const result = securityMap.get(token.address.toLowerCase());
          if (result) {
            token.security = toPortfolioSecurity(result);
            if (result.status === 'failed') hasFailure = true;
          }
        }
        riskStatus = hasFailure ? 'failed' : 'connected';
      } catch {
        riskStatus = 'failed';
        for (const token of securityScanTokens) {
          token.security = {
            provider: riskProviderName,
            status: 'failed',
            summary: 'Token security provider failed; contract-level checks are unavailable.',
            riskLabels: [],
            flags: {}
          };
        }
      }
    }
  }

  return {
    totalUsdValue,
    tokens,
    updatedAt: new Date().toISOString(),
    providerStatus,
    providers: {
      rpc: rpcStatus,
      tokenBalances: tokenBalancesStatus,
      tokenBalancesProvider: providerName,
      prices: pricesStatus,
      priceProvider: priceProviderName,
      risk: riskStatus,
      riskProvider: riskProviderName,
    }
  };
}

function tokenHasHighSecurityRisk(t: TokenInfo) {
  const f = t.security?.flags || {};
  return t.security?.status === 'high-risk'
    || !!f.isHoneypot
    || !!f.cannotSellAll
    || !!f.hasBlacklist
    || !!f.ownerCanChangeBalance
    || !!f.hiddenOwner
    || !!f.canTakeBackOwnership
    || !!f.selfdestruct
    || !!f.externalCall
    || isHighTaxValue(f.buyTax)
    || isHighTaxValue(f.sellTax);
}

function tokenHasMediumSecurityRisk(t: TokenInfo) {
  const f = t.security?.flags || {};
  return t.security?.status === 'warning'
    || !!f.isProxy
    || f.isOpenSource === false
    || !!f.isMintable
    || f.isInDex === false
    || !!f.hasWhitelist
    || !!f.tradingCooldown;
}

function isHighTaxValue(value?: string) {
  if (!value) return false;
  const parsed = Number(value.replace('%', '').trim());
  if (!Number.isFinite(parsed)) return false;
  const normalized = parsed > 1 ? parsed / 100 : parsed;
  return normalized >= 0.1;
}

function securityFinding(t: TokenInfo): TokenFinding['security'] | undefined {
  if (!t.security) return undefined;
  return {
    provider: t.security.provider,
    status: t.security.status,
    labels: t.security.riskLabels || [],
    summary: t.security.summary || 'Token security status unavailable.',
    flags: t.security.flags
  };
}

function describeSecurityFlags(t: TokenInfo) {
  const labels = t.security?.riskLabels || [];
  if (labels.length > 0) return labels.slice(0, 3).join(', ');
  return t.security?.summary || 'contract-level warning';
}

export function analyzePortfolioForRisk(
  portfolio: PortfolioData,
  walletAddress: string,
  chainEnv: string = 'mainnet-readonly'
): PortfolioRiskAnalysis {
  const findings: TokenFinding[] = [];
  const tokens = portfolio.tokens || [];
  const securityProviderName: TokenSecurityProviderName = portfolio.providers?.riskProvider || (portfolio.providers?.risk === 'connected' ? 'goplus' : 'none');
  const securityProviderStatus = securityProviderName === 'none' ? 'missing' : providerStatusToSecurityStatus(portfolio.providers?.risk || 'missing');

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
    } else if (tokenHasHighSecurityRisk(t) || (t.security?.flags?.isMintable && !t.verified && noPrice)) {
      risk = "high";
      reason = `Contract-level security provider reported high-risk flags: ${describeSecurityFlags(t)}.`;
      suggestedHandling = "review-permissions";
    } else if (t.possibleSpam || hasSuspiciousRegex || (numBalance > 100000 && noPrice && !t.verified && !t.logoUrl)) {
      risk = "high";
      if (t.possibleSpam) {
        reason = "Flagged as possible spam or scam asset by token provider.";
        suggestedHandling = "ignore";
      } else if (hasSuspiciousRegex) {
        reason = "Symbol or name contains suspicious URL or claim keyword.";
        suggestedHandling = "ignore";
      } else {
        reason = "Large unexplained balance with no price or verification metadata (low-confidence asset).";
        suggestedHandling = "review-permissions";
      }
    } else if (tokenHasMediumSecurityRisk(t)) {
      risk = "medium";
      reason = `Contract-level security provider reported warning flags: ${describeSecurityFlags(t)}.`;
      suggestedHandling = "verify";
    } else if (t.security?.status === 'failed' || securityProviderStatus === 'missing') {
      risk = "unknown";
      reason = securityProviderStatus === 'missing'
        ? "Token security provider is not configured, so contract-level checks are limited."
        : "Token security scan failed, so contract-level checks are unknown.";
      suggestedHandling = "verify";
    } else if (isKnownStable && (t.verified || !t.possibleSpam)) {
      risk = "low";
      reason = !noPrice ? `Verified well-known token on Base network with confirmed USD value ($${t.usdValue}). No major warnings detected by configured providers.` : "Verified well-known token on Base network. No major warnings detected by configured providers.";
      suggestedHandling = "keep-watchlist";
    } else if (noPrice && !t.verified && numBalance > 1000) {
      risk = "medium";
      reason = "Unverified token with missing USD price and a notable balance (low-confidence asset).";
      suggestedHandling = "verify";
    } else if (noPrice && !t.verified) {
      risk = "medium";
      reason = "Unverified token with missing USD price or logo metadata (low-confidence asset).";
      suggestedHandling = "verify";
    } else if (!t.logoUrl && (!t.name || t.symbol.length > 10)) {
      risk = "medium";
      reason = "Token lacks logo and standard identification metadata.";
      suggestedHandling = "verify";
    } else if (t.verified || !noPrice || t.security?.status === 'ok') {
      risk = "low";
      reason = !noPrice ? `Token has confirmed USD price ($${t.usdValue}). No major warnings detected by configured providers.` : "No major warnings detected by configured providers.";
      suggestedHandling = "monitor";
    }

    findings.push({
      symbol: t.symbol,
      name: t.name,
      address: t.address,
      balanceFormatted: t.balanceFormatted,
      usdValue: !noPrice ? t.usdValue : undefined,
      priceStatus: noPrice ? "missing" : undefined,
      risk,
      reason,
      suggestedHandling,
      security: securityFinding(t)
    });
  }

  const riskOrder: Record<string, number> = { high: 0, medium: 1, unknown: 2, low: 3 };
  findings.sort((a, b) => {
    const rDiff = (riskOrder[a.risk] ?? 4) - (riskOrder[b.risk] ?? 4);
    if (rDiff !== 0) return rDiff;
    const aVal = a.usdValue && !isNaN(Number(a.usdValue)) ? Number(a.usdValue) : 0;
    const bVal = b.usdValue && !isNaN(Number(b.usdValue)) ? Number(b.usdValue) : 0;
    return bVal - aVal;
  });

  const suspiciousTokens = findings.filter(f => f.risk === 'high' || f.risk === 'medium');
  const suspiciousTokenCount = suspiciousTokens.length;
  const tokenCount = tokens.length;
  const visibleTokenCount = tokens.length;
  const provider = portfolio.providers?.tokenBalancesProvider || "none";
  const priceProvider = portfolio.providers?.priceProvider || portfolio.providers?.prices || "none";
  const chain = (chainEnv === 'mainnet-readonly' || chainEnv === 'mainnet') ? "base-mainnet" : "base-sepolia";

  let pricedTokenCount = 0;
  let unpricedTokenCount = 0;
  for (const t of tokens) {
    if ((t.usdValue && !isNaN(Number(t.usdValue)) && Number(t.usdValue) > 0) || (t.usdValue === '0.00' && t.usdPrice) || (t.usdValue && t.usdValue !== '0.00')) {
      pricedTokenCount++;
    } else {
      unpricedTokenCount++;
    }
  }

  const securityCheckedTokenCount = tokens.filter(t => t.security && t.security.provider !== 'none' && t.security.status !== 'failed' && t.security.status !== 'unknown').length;
  const securityHighRiskCount = tokens.filter(t => t.security?.status === 'high-risk').length;
  const securityWarningCount = tokens.filter(t => t.security?.status === 'warning').length;

  let summary: string;
  if (securityHighRiskCount > 0) {
    summary = `Detected ${securityHighRiskCount} tokens with high-risk security flags and ${suspiciousTokenCount} suspicious or low-confidence tokens out of ${tokenCount} assets. No execution is possible in read-only mode.`;
  } else if (suspiciousTokenCount > 0) {
    summary = `Detected ${suspiciousTokenCount} low-confidence or suspicious tokens out of ${tokenCount} assets. Some may be unverified, unpriced, or have warning-level provider signals. No execution is possible in read-only mode.`;
  } else if (securityProviderStatus === 'missing') {
    summary = `Reviewed ${tokenCount} Base portfolio assets using available metadata. Token security provider is not configured, so contract-level checks are limited. No execution is possible in read-only mode.`;
  } else {
    summary = `Reviewed ${tokenCount} Base portfolio assets. No major warnings detected by configured providers. No execution is possible in read-only mode.`;
  }

  const isPriceMissing = portfolio.providers?.prices === "missing" || priceProvider === "none" || priceProvider === "missing";
  const priceStep = isPriceMissing
    ? "Price provider is missing, so value-based ranking is limited."
    : "Ranked findings using available USD values.";

  const securityStep = securityProviderStatus === 'missing'
    ? "Token security provider is missing, so contract-level checks are limited."
    : securityProviderStatus === 'failed'
      ? "Token security scan failed for one or more tokens; retry later before interacting."
      : "Reviewed configured token security provider signals where available.";

  const suggestedNextSteps = [
    priceStep,
    securityStep,
    "Review permissions and verify token contracts before interacting.",
    "Avoid interacting with tokens that show high-risk flags or suspicious claim/URL labels.",
    "Use a trusted wallet interface to revoke approvals if needed; MioAgent will not auto-revoke or create transactions in read-only mode."
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
      priceProvider,
      totalUsdValue: portfolio.totalUsdValue,
      pricedTokenCount,
      unpricedTokenCount,
      providerStatus: portfolio.providerStatus,
      securityCheckedTokenCount,
      securityHighRiskCount,
      securityWarningCount,
      securityProvider: securityProviderName
    },
    securityProvider: {
      provider: securityProviderName,
      status: securityProviderStatus
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

  const overallRisk = analysis.portfolioSnapshot.securityHighRiskCount > 0 || analysis.portfolioSnapshot.suspiciousTokenCount > 0 ? "high" : "low";

  return {
    type: "recommendation",
    title: intent?.title || "Token Risk & Portfolio Review",
    instruction: message,
    reason: intent?.reason || `Automated risk analysis created by Agent Stream for: "${message}"`,
    expectedEffect: intent?.expectedEffect || "Analyze Base token list, filter spam/airdrop tokens, and flag any high-risk assets.",
    risk: isReadonly ? (overallRisk === 'high' ? "medium" : "low") : overallRisk,
    riskScore: analysis.portfolioSnapshot.securityHighRiskCount > 0 ? 85 : analysis.portfolioSnapshot.suspiciousTokenCount > 0 ? 75 : 15,
    chainMode: chainEnv,
    safetyState: isReadonly ? "blocked" : (canExecute ? "executable" : "blocked"),
    executable: canExecute,
    executionStatus: isReadonly ? "read-only" : (canExecute ? "executable" : "blocked"),
    createdBy: intent?.createdBy || "agent-stream",
    walletAddress: walletAddress,
    providerContext: providerContext || {
      tokenBalances: analysis.portfolioSnapshot.provider,
      prices: analysis.portfolioSnapshot.priceProvider || "missing",
      risk: analysis.securityProvider.status,
      securityProvider: analysis.securityProvider.provider
    },
    analysis: analysis
  };
}

