import { getTokenBalancesProviderFromEnv, getTokenBalancesFallbackProviderFromEnv, getPriceProviderFromEnv, getTokenSecurityProviderFromEnv, getApprovalProviderFromEnv, type TokenSecurityResult, type TokenSecurityFlags, type TokenSecurityProviderName, type TokenSecurityStatus, type TokenApproval, type TokenBalance, type TokenPrice } from '@mioagent/data-providers';
import {
  cachedProviderCall,
  getProviderCacheOrchestratorFromEnv,
  setProviderCacheForTests,
  clearProviderCacheForTests,
  InMemoryProviderCacheStore,
  ProviderBudget,
  type CacheStatus,
  type CachedCallResult,
  type ProviderName,
} from './providerCache.js';

export type { TokenApproval } from '@mioagent/data-providers';

export interface ApprovalFinding {
  tokenSymbol?: string;
  tokenAddress: string;
  spender?: string;
  spenderAddress: string;
  spenderLabel?: string;
  allowanceRaw?: string;
  allowanceFormatted?: string;
  allowanceUsd?: number;
  isUnlimited: boolean;
  riskLevel: "critical" | "high" | "medium" | "low";
  reason: string;
}

export interface ApprovalRecommendation {
  id: string;
  title: string;
  description: string;
  riskLevel: "critical" | "high" | "medium" | "low";
  tokenSymbol?: string;
  spenderAddress: string;
  spenderLabel?: string;
  calls: [];
  kind: "recommendation";
}

export interface ApprovalRiskAnalysis {
  summary: string;
  totalApprovals: number;
  unlimitedApprovals: number;
  riskySpenderApprovals: number;
  findings: ApprovalFinding[];
  recommendations: ApprovalRecommendation[];
  status?: ApprovalScanStatus;
  provider?: string;
  scannerUnavailable?: boolean;
  note?: string;
}

export type ApprovalScanStatus =
  | "not_requested"
  | "live"
  | "cached"
  | "stale"
  | "partial"
  | "failed"
  | "rate_limited"
  | "budget_exhausted"
  | "temporarily_unavailable"
  | "connected"
  | "missing"
  | "disabled";

export interface ProviderCallSummaryItem {
  provider: string;
  status: string;
  providerCalled: boolean;
  budgetExhausted: boolean;
  cacheAgeSeconds?: number;
  requested?: boolean;
  errorCode?: string;
  note?: string;
}

export interface ApprovalScanSummary extends ProviderCallSummaryItem {
  requested: boolean;
  totalApprovals: number;
  tokenCount: number;
  unlimitedCount: number;
  riskySpenderCount: number;
}

export interface ApprovalSummary {
  requested: boolean;
  status: ApprovalScanStatus;
  provider: string;
  totalApprovals: number;
  tokenCount: number;
  unlimitedApprovals: number;
  riskySpenderApprovals: number;
  budgetExhausted?: boolean;
  errorCode?: string;
  note?: string;
}

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
  dataFreshness?: "live" | "cached";
}

export interface PortfolioData {
  totalUsdValue?: string;
  tokens: TokenInfo[];
  updatedAt: string;
  providerStatus: string;
  dataFreshness?: "live" | "cached" | "stale" | "partial" | "failed";
  cacheAgeSeconds?: number;
  providerBudgetStatus?: { exhausted: boolean; providers: string[] };
  providerCallsMade?: number;
  providerCallSummary?: Record<string, ProviderCallSummaryItem>;
  providerContext?: Record<string, unknown>;
  approvalScan?: ApprovalScanSummary;
  approvalSummary?: ApprovalSummary;
  approvalFindings?: ApprovalFinding[];
  providers: {
    rpc: string;
    tokenBalances: "connected" | "missing" | "failed" | "stale" | "disabled" | "rate_limited";
    tokenBalancesProvider: string;
    prices: string;
    priceProvider?: string;
    risk: "connected" | "missing" | "failed" | "partial" | "disabled";
    riskProvider?: TokenSecurityProviderName;
    approvals?: string;
    approvalProvider?: string;
  };
  approvals?: TokenApproval[];
}

export interface FetchInternalPortfolioOptions {
  includeApprovals?: boolean;
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
  overallRiskLevel?: 'low' | 'medium' | 'high' | 'critical' | 'unknown';
  summary: string;
  providerContext?: Record<string, unknown>;
  totalTokens?: number;
  approvalSummary?: ApprovalSummary;
  approvals?: TokenApproval[];
  approvalFindings?: ApprovalFinding[];
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
    dataFreshness?: "live" | "cached" | "stale" | "partial" | "failed";
    cacheAgeSeconds?: number;
    providerBudgetStatus?: { exhausted: boolean; providers: string[] };
    providerCallsMade?: number;
    snapshotTimestamp?: string;
  };
  securityProvider: {
    provider: TokenSecurityProviderName;
    status: "connected" | "missing" | "failed" | "partial" | "disabled";
    coverage: "complete" | "partial" | "unavailable";
    failureReason?: string;
  };
  tokenFindings: TokenFinding[];
  suggestedNextSteps: string[];
  approvalAnalysis?: ApprovalRiskAnalysis;
}

export const APPROVAL_SCANNER_UNAVAILABLE_NOTE = "Moralis approval scanner is temporarily unavailable due to provider budget/rate limits.";
export const APPROVAL_SCANNER_UNAVAILABLE_UI_NOTE = "Approval scanner unavailable — Moralis CU limit reached. Try after reset or upgrade provider.";

export function sanitizeSecurityFailureReason(value?: string): string {
  const normalized = (value || '').toLowerCase();
  if (/rate|429|budget|quota|limit/.test(normalized)) {
    return 'Contract check service is temporarily rate-limited.';
  }
  if (/auth|unauthor|forbidden|401|403/.test(normalized)) {
    return 'Contract check service authentication is unavailable.';
  }
  if (/timeout|timed out|network|fetch|unreachable|econn|enotfound/.test(normalized)) {
    return 'Contract check service is temporarily unreachable.';
  }
  if (/no usable|unknown result|empty result/.test(normalized)) {
    return 'No usable token-security verdicts were returned.';
  }
  if (/not configured|disabled|missing/.test(normalized)) {
    return 'Contract checks are not configured for this scan.';
  }
  return 'Contract check service did not return usable results.';
}

export function isApprovalScannerUnavailableStatus(status?: string): boolean {
  return status === 'budget_exhausted' || status === 'rate_limited' || status === 'temporarily_unavailable';
}

function approvalUnavailableNote(status?: string): string | undefined {
  return isApprovalScannerUnavailableStatus(status) ? APPROVAL_SCANNER_UNAVAILABLE_NOTE : undefined;
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

function providerStatusToSecurityStatus(status: string): "connected" | "missing" | "failed" | "partial" | "disabled" {
  if (status === 'failed') return 'failed';
  if (status === 'missing') return 'missing';
  if (status === 'partial') return 'partial';
  if (status === 'disabled') return 'disabled';
  return 'connected';
}

function providerDisplayName(provider?: string) {
  if (provider === 'moralis') return 'Moralis';
  if (provider === 'alchemy') return 'Alchemy';
  if (provider === 'coingecko') return 'CoinGecko';
  if (provider === 'goplus') return 'GoPlus';
  return provider || 'token';
}

// Test helpers: force an in-memory orchestrator so portfolio/route tests stay
// hermetic (no DB writes) and budget counters reset between tests.
export function clearTokenBalancesCacheForTests() {
  clearProviderCacheForTests();
  setProviderCacheForTests(new InMemoryProviderCacheStore(), new ProviderBudget(20, 300));
}

// Seed an already-expired balances cache entry so a failing live provider returns
// cached balances with stale status (mirrors the pre-T11.6 resilience behavior).
export function setTokenBalancesCacheForTests(chainId: number, address: string, tokens: TokenInfo[], provider: ProviderName = 'moralis'): Promise<void> {
  const orch = getProviderCacheOrchestratorFromEnv();
  const key = `provider:${provider}:balances:${chainId}:${address.toLowerCase()}`;
  const now = Date.now();
  return orch.store.set({
    key,
    provider,
    chainId,
    payload: tokens,
    status: 'stale',
    createdAt: now - 60_000,
    updatedAt: now - 60_000,
    expiresAt: now - 1000,
  });
}

type FreshnessTrack = {
  status: CacheStatus;
  cacheAgeSeconds?: number;
  providerCalled: boolean;
  budgetExhausted: boolean;
  provider: ProviderName;
};

function computePortfolioFreshness(track: FreshnessTrack[]): {
  dataFreshness: "live" | "cached" | "stale" | "partial" | "failed";
  cacheAgeSeconds: number;
  providerBudgetStatus: { exhausted: boolean; providers: string[] };
  providerCallsMade: number;
} {
  if (track.length === 0) {
    return { dataFreshness: 'live', cacheAgeSeconds: 0, providerBudgetStatus: { exhausted: false, providers: [] }, providerCallsMade: 0 };
  }
  const hasStale = track.some(t => t.status === 'stale');
  const hasRateLimited = track.some(t => t.status === 'rate_limited');
  const hasFailed = track.some(t => t.status === 'failed');
  const hasCached = track.some(t => t.status === 'cached');
  const hasLive = track.some(t => t.status === 'live');
  let dataFreshness: "live" | "cached" | "stale" | "partial" | "failed";
  if (hasStale) dataFreshness = 'stale';
  else if (hasRateLimited) dataFreshness = 'partial';
  else if (hasFailed && (hasLive || hasCached)) dataFreshness = 'partial';
  else if (hasCached) dataFreshness = 'cached';
  else if (hasLive) dataFreshness = 'live';
  else dataFreshness = 'failed';
  const cacheAgeSeconds = Math.max(0, ...track.map(t => t.cacheAgeSeconds ?? 0));
  const exhaustedProviders = Array.from(new Set(track.filter(t => t.budgetExhausted).map(t => t.provider)));
  return {
    dataFreshness,
    cacheAgeSeconds,
    providerBudgetStatus: { exhausted: exhaustedProviders.length > 0, providers: exhaustedProviders },
    providerCallsMade: track.filter(t => t.providerCalled).length,
  };
}

export async function fetchInternalPortfolio(address: string, chainEnv: string = 'sepolia', options: FetchInternalPortfolioOptions = {}): Promise<PortfolioData> {
  const chainId = chainEnv === 'sepolia' ? 84532 : 8453;
  const includeApprovals = options.includeApprovals === true;
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

  const orch = getProviderCacheOrchestratorFromEnv();
  const freshnessTrack: FreshnessTrack[] = [];
  const providerCallSummary: Record<string, ProviderCallSummaryItem> = {};

  // --- Token balances (cached + budget-guarded) ---
  const { provider, status, statusCode, providerName } = getTokenBalancesProviderFromEnv();
  let providerStatus = status;
  let tokenBalancesStatus: "connected" | "missing" | "failed" | "stale" | "disabled" | "rate_limited" = statusCode;

  if (provider && providerName !== 'none') {
    const balKey = `provider:${providerName}:balances:${chainId}:${address.toLowerCase()}`;
    const balRes = await cachedProviderCall<TokenBalance[]>({
      key: balKey,
      provider: providerName as ProviderName,
      chainId,
      ttlSeconds: orch.ttls.balances,
      store: orch.store,
      budget: orch.budget,
      fetcher: () => provider.getTokenBalances({ address, chainId }),
    }).catch((err: unknown): CachedCallResult<TokenBalance[]> => ({
      data: undefined,
      status: 'failed',
      fromCache: false,
      providerCalled: false,
      budgetExhausted: false,
      error: err instanceof Error ? err.message : String(err),
    }));
    let effectiveBalRes = balRes;
    let effectiveBalanceProviderName = providerName as ProviderName;

    if (providerName === 'alchemy' && balRes.status === 'rate_limited' && balRes.data === undefined) {
      const fallback = getTokenBalancesFallbackProviderFromEnv();
      if (fallback.providerName === 'moralis' && fallback.statusCode === 'connected') {
        const fallbackKey = `provider:moralis:balances:${chainId}:${address.toLowerCase()}`;
        const fallbackRes = await cachedProviderCall<TokenBalance[]>({
          key: fallbackKey,
          provider: 'moralis',
          chainId,
          ttlSeconds: orch.ttls.balances,
          store: orch.store,
          budget: orch.budget,
          fetcher: () => fallback.provider.getTokenBalances({ address, chainId }),
        }).catch((err: unknown): CachedCallResult<TokenBalance[]> => ({
          data: undefined,
          status: 'failed',
          fromCache: false,
          providerCalled: false,
          budgetExhausted: false,
          error: err instanceof Error ? err.message : String(err),
        }));
        providerCallSummary.balanceFallback = {
          provider: fallback.providerName,
          status: fallbackRes.status,
          providerCalled: fallbackRes.providerCalled,
          budgetExhausted: fallbackRes.budgetExhausted,
          cacheAgeSeconds: fallbackRes.cacheAgeSeconds,
          requested: true,
        };
        freshnessTrack.push({
          status: fallbackRes.status,
          cacheAgeSeconds: fallbackRes.cacheAgeSeconds,
          providerCalled: fallbackRes.providerCalled,
          budgetExhausted: fallbackRes.budgetExhausted,
          provider: 'moralis',
        });
        if (fallbackRes.data !== undefined) {
          effectiveBalRes = fallbackRes;
          effectiveBalanceProviderName = 'moralis';
        }
      } else {
        providerCallSummary.balanceFallback = {
          provider: fallback.providerName,
          status: fallback.statusCode,
          providerCalled: false,
          budgetExhausted: false,
          requested: false,
        };
      }
    }

    freshnessTrack.push({
      status: balRes.status === 'rate_limited' && balRes.data !== undefined ? 'stale' : balRes.status,
      cacheAgeSeconds: balRes.cacheAgeSeconds,
      providerCalled: balRes.providerCalled,
      budgetExhausted: balRes.budgetExhausted,
      provider: providerName as ProviderName,
    });
    providerCallSummary.balances = {
      provider: providerName,
      status: balRes.status,
      providerCalled: balRes.providerCalled,
      budgetExhausted: balRes.budgetExhausted,
      cacheAgeSeconds: balRes.cacheAgeSeconds,
      requested: true,
    };

    const erc20Balances = effectiveBalRes.data || [];
    const hasBalancePayload = effectiveBalRes.data !== undefined;
    if (effectiveBalRes.status === 'live' || effectiveBalRes.status === 'cached' || effectiveBalRes.status === 'stale' || (effectiveBalRes.status === 'rate_limited' && hasBalancePayload)) {
      const df: "live" | "cached" = effectiveBalRes.status === 'live' ? 'live' : 'cached';
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
          dataFreshness: df,
        });
      }
      tokens[0].dataFreshness = df;
      if (balRes.status === 'rate_limited') {
        tokenBalancesStatus = 'rate_limited';
        providerStatus = 'Alchemy rate-limited. Showing cached/native balance data.';
      } else if (effectiveBalRes.status === 'stale') {
        tokenBalancesStatus = 'stale';
        providerStatus = 'Using cached token balances because live provider failed.';
      } else if (tokens.length === 1 && (effectiveBalanceProviderName === 'moralis' || effectiveBalanceProviderName === 'alchemy')) {
        providerStatus = 'No ERC-20 tokens found for this wallet';
      }
      // 'live' / 'cached' keep the factory status string (e.g. 'Moralis connected').
    } else {
      tokenBalancesStatus = balRes.status === 'rate_limited' ? 'rate_limited' : 'failed';
      providerStatus = balRes.status === 'rate_limited'
        ? 'Alchemy rate-limited. Showing cached/native balance data.'
        : balRes.budgetExhausted
        ? 'Provider budget reached for token balances. Showing native ETH only.'
        : 'Token balances provider failed. Showing native ETH only.';
    }
  } else {
    providerCallSummary.balances = {
      provider: providerName,
      status: tokenBalancesStatus,
      providerCalled: false,
      budgetExhausted: false,
      requested: true,
    };
  }

  // --- Token prices (cached + budget-guarded) ---
  const { provider: priceProvider, status: priceStatusText, statusCode: priceStatusCode, providerName: priceProviderName } = getPriceProviderFromEnv();
  let pricesStatus: "connected" | "missing" | "failed" | "partial" | "disabled" = priceStatusCode;

  if (priceProvider && priceProviderName !== 'none') {
    const priceKey = `provider:${priceProviderName}:prices:${chainId}:${address.toLowerCase()}`;
    const priceRes = await cachedProviderCall<TokenPrice[]>({
      key: priceKey,
      provider: priceProviderName as ProviderName,
      chainId,
      ttlSeconds: orch.ttls.prices,
      store: orch.store,
      budget: orch.budget,
      fetcher: () => priceProvider.getTokenPrices({ chainId, tokens }),
    }).catch((err: unknown): CachedCallResult<TokenPrice[]> => ({
      data: undefined,
      status: 'failed',
      fromCache: false,
      providerCalled: false,
      budgetExhausted: false,
      error: err instanceof Error ? err.message : String(err),
    }));
    freshnessTrack.push({
      status: priceRes.status,
      cacheAgeSeconds: priceRes.cacheAgeSeconds,
      providerCalled: priceRes.providerCalled,
      budgetExhausted: priceRes.budgetExhausted,
      provider: priceProviderName as ProviderName,
    });
    providerCallSummary.prices = {
      provider: priceProviderName,
      status: priceRes.status,
      providerCalled: priceRes.providerCalled,
      budgetExhausted: priceRes.budgetExhausted,
      cacheAgeSeconds: priceRes.cacheAgeSeconds,
      requested: true,
    };

    const prices = priceRes.data || [];
    if (prices.length > 0) {
      const priceMap = new Map(prices.map(p => [(p.address || p.symbol).toLowerCase(), p]));
      let missingPriceCount = 0;
      let pricedTokensCount = 0;
      for (const t of tokens) {
        const key = (t.address === 'native' || !t.address ? 'ETH' : t.address).toLowerCase();
        const p = priceMap.get(key) || priceMap.get(t.symbol.toLowerCase());
        if (p && p.usdPrice && !isNaN(Number(p.usdPrice))) {
          t.usdPrice = p.usdPrice;
          t.priceConfidence = p.confidence;
          const val = Number(t.balanceFormatted) * Number(p.usdPrice);
          t.usdValue = val.toFixed(2);
          pricedTokensCount++;
        } else if (!t.usdValue && !t.usdPrice) {
          t.usdPrice = undefined;
          t.usdValue = undefined;
          t.priceConfidence = "unknown";
          missingPriceCount++;
        } else if (t.usdValue) {
          pricedTokensCount++;
        }
      }
      if (pricedTokensCount === 0 && tokens.length > 0) {
        pricesStatus = "failed";
      } else if (missingPriceCount > 0 || priceRes.status === 'stale') {
        pricesStatus = "partial";
      }
    } else {
      pricesStatus = priceRes.budgetExhausted ? "partial" : "failed";
      if (tokenBalancesStatus !== 'failed') {
        providerStatus = priceRes.budgetExhausted
          ? `Price provider budget reached; showing token balances without fresh USD values.`
          : `Price provider (${priceProviderName}) failed to fetch prices. Showing token balances without USD values.`;
      }
    }
  } else {
    providerCallSummary.prices = {
      provider: priceProviderName,
      status: pricesStatus,
      providerCalled: false,
      budgetExhausted: false,
      requested: true,
    };
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

  // --- Token security / GoPlus (cached + budget-guarded) ---
  const { provider: tokenSecurityProvider, statusCode: initialRiskStatus, providerName: riskProviderName } = getTokenSecurityProviderFromEnv();
  let riskStatus: "connected" | "missing" | "failed" | "partial" | "disabled" = initialRiskStatus as any;
  if (riskProviderName !== 'none') {
    const securityScanTokens = prioritizeSecurityScanTokens(tokens);
    if (securityScanTokens.length > 0) {
      const addrHash = securityScanTokens.map(t => t.address.toLowerCase()).sort().join(',');
      const secKey = `provider:${riskProviderName}:security:${chainId}:${addrHash}`;
      const secRes = await cachedProviderCall<TokenSecurityResult[]>({
        key: secKey,
        provider: riskProviderName,
        chainId,
        ttlSeconds: orch.ttls.security,
        store: orch.store,
        budget: orch.budget,
        shouldCache: (results) => results.length > 0
          && results.every((result) => result.status !== 'failed' && result.status !== 'unknown'),
        fetcher: async () => {
          const results = await tokenSecurityProvider.getTokenSecurity({
            chainId,
            tokenAddresses: securityScanTokens.map(t => t.address)
          });
          // Treat an all-failed/all-unknown response as a provider failure so the
          // orchestrator falls back to stale cache instead of poisoning the L2.
          const anyUsable = results.some(r => r.status !== 'failed' && r.status !== 'unknown');
          if (!anyUsable && results.length > 0) throw new Error('Token security provider returned no usable results');
          return results;
        },
      }).catch((err: unknown): CachedCallResult<TokenSecurityResult[]> => ({
        data: undefined,
        status: 'failed',
        fromCache: false,
        providerCalled: false,
        budgetExhausted: false,
        error: err instanceof Error ? err.message : String(err),
      }));
      freshnessTrack.push({
        status: secRes.status,
        cacheAgeSeconds: secRes.cacheAgeSeconds,
        providerCalled: secRes.providerCalled,
        budgetExhausted: secRes.budgetExhausted,
        provider: riskProviderName,
      });
      providerCallSummary.risk = {
        provider: riskProviderName,
        status: secRes.status,
        providerCalled: secRes.providerCalled,
        budgetExhausted: secRes.budgetExhausted,
        cacheAgeSeconds: secRes.cacheAgeSeconds,
        requested: true,
        errorCode: secRes.errorCode,
        note: secRes.error ? sanitizeSecurityFailureReason(`${secRes.errorCode || ''} ${secRes.error}`) : undefined,
      };

      if (secRes.data) {
        const securityResults = secRes.data;
        const securityMap = new Map(securityResults.map(result => [result.address.toLowerCase(), result]));
        let checkedCount = 0;
        let hasFailure = false;
        for (const token of securityScanTokens) {
          const result = securityMap.get(token.address.toLowerCase());
          if (result && result.status !== 'failed' && result.status !== 'unknown') {
            token.security = toPortfolioSecurity(result);
            checkedCount++;
          } else if (result) {
            token.security = toPortfolioSecurity(result);
            if (result.status === 'failed') hasFailure = true;
          }
        }
        const { setTokenSecurityHealthStatus } = require('@mioagent/data-providers');
        if (secRes.status === 'stale') {
          riskStatus = checkedCount > 0 ? 'partial' : 'failed';
          setTokenSecurityHealthStatus(riskStatus === 'failed' ? 'failed' : 'partial');
        } else if (checkedCount === 0) {
          riskStatus = 'failed';
          setTokenSecurityHealthStatus('failed');
        } else if (checkedCount < securityScanTokens.length || hasFailure) {
          riskStatus = 'partial';
          setTokenSecurityHealthStatus('partial');
        } else {
          riskStatus = 'connected';
          setTokenSecurityHealthStatus('connected');
        }
      } else {
        riskStatus = 'failed';
        const { setTokenSecurityHealthStatus } = require('@mioagent/data-providers');
        setTokenSecurityHealthStatus('failed');
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
  if (!providerCallSummary.risk) {
    providerCallSummary.risk = {
      provider: riskProviderName,
      status: riskStatus,
      providerCalled: false,
      budgetExhausted: false,
      requested: riskProviderName !== 'none',
    };
  }

  // --- Approvals (explicit only). Normal portfolio scans never call Moralis approvals. ---
  const approvalEnv = getApprovalProviderFromEnv();
  let approvalsData: TokenApproval[] | undefined;
  let approvalFindings: ApprovalFinding[] | undefined;
  let approvalsStatus: "connected" | "missing" | "failed" | "partial" | "disabled" | "rate_limited" | "budget_exhausted" | "temporarily_unavailable" = approvalEnv.statusCode;
  let approvalProviderName = approvalEnv.providerName;
  let approvalScan: ApprovalScanSummary = {
    requested: includeApprovals,
    provider: approvalProviderName,
    status: includeApprovals ? approvalsStatus : 'not_requested',
    providerCalled: false,
    budgetExhausted: false,
    totalApprovals: 0,
    tokenCount: 0,
    unlimitedCount: 0,
    riskySpenderCount: 0,
  };
  let approvalSummary: ApprovalSummary = {
    requested: includeApprovals,
    status: includeApprovals ? approvalsStatus : 'not_requested',
    provider: approvalProviderName,
    totalApprovals: 0,
    tokenCount: 0,
    unlimitedApprovals: 0,
    riskySpenderApprovals: 0,
  };

  if (includeApprovals) {
    try {
      const appRes = await fetchInternalApprovals(address, chainEnv);
      approvalsData = appRes.approvals;
      approvalsStatus = appRes.status;
      approvalProviderName = appRes.provider;
      const appAnalysis = analyzeApprovalsForRisk(approvalsData, { tokens } as PortfolioData);
      approvalFindings = appAnalysis.findings;
      const scanStatus = (appRes.cache?.status || appRes.status) as ApprovalScanStatus;
      approvalScan = {
        requested: true,
        provider: approvalProviderName,
        status: scanStatus,
        providerCalled: appRes.cache?.providerCalled ?? false,
        budgetExhausted: appRes.cache?.budgetExhausted ?? false,
        cacheAgeSeconds: appRes.cache?.cacheAgeSeconds,
        errorCode: appRes.cache?.errorCode,
        note: approvalUnavailableNote(scanStatus),
        totalApprovals: approvalsData.length,
        tokenCount: appRes.tokenCount,
        unlimitedCount: appRes.unlimitedCount,
        riskySpenderCount: appRes.riskySpenderCount,
      };
      approvalSummary = {
        requested: true,
        status: scanStatus,
        provider: approvalProviderName,
        totalApprovals: approvalsData.length,
        tokenCount: appRes.tokenCount,
        unlimitedApprovals: appAnalysis.unlimitedApprovals,
        riskySpenderApprovals: appAnalysis.riskySpenderApprovals,
        budgetExhausted: appRes.cache?.budgetExhausted ?? false,
        errorCode: appRes.cache?.errorCode,
        note: approvalUnavailableNote(scanStatus),
      };
    } catch {
      approvalsStatus = "failed";
      approvalScan = {
        requested: true,
        provider: approvalProviderName,
        status: 'failed',
        providerCalled: false,
        budgetExhausted: false,
        note: 'Approval scan failed before provider status was available.',
        totalApprovals: 0,
        tokenCount: 0,
        unlimitedCount: 0,
        riskySpenderCount: 0,
      };
      approvalSummary = {
        requested: true,
        status: 'failed',
        provider: approvalProviderName,
        totalApprovals: 0,
        tokenCount: 0,
        unlimitedApprovals: 0,
        riskySpenderApprovals: 0,
        note: 'Approval scan failed before provider status was available.',
      };
    }
  }
  providerCallSummary.approvals = approvalScan;

  const freshness = computePortfolioFreshness(freshnessTrack);
  const providerContext = {
    balancesProvider: providerName,
    tokenBalancesProvider: providerName,
    tokenBalances: providerName,
    priceProvider: priceProviderName,
    prices: priceProviderName,
    riskProvider: riskProviderName,
    securityProvider: riskProviderName,
    approvalsProvider: approvalProviderName,
    approvalProvider: approvalProviderName,
    portfolioScanStatus: freshness.dataFreshness,
    approvalScanStatus: approvalScan.status,
    approvalScanRequested: includeApprovals,
    balancesStatus: providerCallSummary.balances?.status,
    balancesFallbackProvider: providerCallSummary.balanceFallback?.provider,
    balancesFallbackStatus: providerCallSummary.balanceFallback?.status,
    providerCallSummary,
  };

  return {
    totalUsdValue,
    tokens,
    updatedAt: new Date().toISOString(),
    providerStatus,
    dataFreshness: freshness.dataFreshness,
    cacheAgeSeconds: freshness.cacheAgeSeconds,
    providerBudgetStatus: freshness.providerBudgetStatus,
    providerCallsMade: freshness.providerCallsMade,
    providerCallSummary,
    providerContext,
    approvalScan,
    approvalSummary,
    approvalFindings,
    providers: {
      rpc: rpcStatus,
      tokenBalances: tokenBalancesStatus,
      tokenBalancesProvider: providerName,
      prices: pricesStatus,
      priceProvider: priceProviderName,
      risk: riskStatus,
      riskProvider: riskProviderName,
      approvals: approvalsStatus,
      approvalProvider: approvalProviderName,
    },
    approvals: includeApprovals ? (approvalsData || []) : undefined,
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

export function analyzeApprovalsForRisk(
  approvals: TokenApproval[],
  portfolio?: PortfolioData
): ApprovalRiskAnalysis {
  const findings: ApprovalFinding[] = [];
  const majorSymbols = ['ETH', 'WETH', 'USDC', 'USDT', 'DAI', 'CBETH', 'DEGEN', 'EURC', 'AERO'];

  for (const a of approvals) {
    const hasVerifiedLabel = Boolean(a.spenderLabel && a.spenderLabel.trim() !== '');
    const isZero = a.allowanceRaw === '0' || (!a.isUnlimited && Number(a.allowanceFormatted) === 0);

    const tokenSymbolUpper = (a.tokenSymbol || '').toUpperCase();
    let isMajorValueToken = tokenSymbolUpper !== '' && majorSymbols.includes(tokenSymbolUpper);
    if (portfolio?.tokens) {
      const match = portfolio.tokens.find(
        t => t.address.toLowerCase() === a.tokenAddress.toLowerCase() || (tokenSymbolUpper !== '' && t.symbol.toUpperCase() === tokenSymbolUpper)
      );
      if (match && match.usdValue && Number(match.usdValue) > 0) {
        isMajorValueToken = true;
      }
    }

    let riskLevel: "critical" | "high" | "medium" | "low" = "low";
    let reason = "Well-known protocol with limited spend access.";

    if (isZero) {
      riskLevel = "low";
      reason = "Zero allowance permission.";
    } else if (!hasVerifiedLabel && a.isUnlimited && isMajorValueToken) {
      riskLevel = "critical";
      reason = `Unverified spender has unlimited spend access to valuable token (${a.tokenSymbol}).`;
    } else if (!hasVerifiedLabel || (a.isUnlimited && isMajorValueToken)) {
      riskLevel = "high";
      if (!hasVerifiedLabel) {
        reason = `Unverified spender has spend access to ${a.tokenSymbol}.`;
      } else {
        reason = `Unlimited spend access to valuable token (${a.tokenSymbol}) even for known protocol (${a.spenderLabel}).`;
      }
    } else {
      let isOld = false;
      if (a.lastUpdatedAt) {
        const ts = new Date(a.lastUpdatedAt).getTime();
        if (!isNaN(ts) && Date.now() - ts > 180 * 24 * 60 * 60 * 1000) {
          isOld = true;
        }
      }
      if (isOld) {
        riskLevel = "medium";
        reason = `Permission was granted over 180 days ago (${a.spenderLabel || a.spenderAddress}).`;
      } else {
        riskLevel = "low";
        reason = `Limited allowance granted to known protocol (${a.spenderLabel || a.spenderAddress}).`;
      }
    }

    findings.push({
      tokenSymbol: a.tokenSymbol,
      tokenAddress: a.tokenAddress,
      spender: a.spenderAddress,
      spenderAddress: a.spenderAddress,
      spenderLabel: a.spenderLabel,
      allowanceRaw: a.allowanceRaw,
      allowanceFormatted: a.allowanceFormatted,
      allowanceUsd: a.allowanceUsd,
      isUnlimited: a.isUnlimited,
      riskLevel,
      reason,
    });
  }

  const totalApprovals = approvals.length;
  const unlimitedApprovals = approvals.filter(a => a.isUnlimited).length;
  const riskySpenderApprovals = findings.filter(f => f.riskLevel === 'critical' || f.riskLevel === 'high').length;

  let summary = `All ${totalApprovals} spend permission(s) appear well-scoped and low risk.`;
  if (totalApprovals === 0) {
    summary = "No active approvals found — nothing to revoke.";
  } else if (riskySpenderApprovals > 0) {
    summary = `Found ${riskySpenderApprovals} risky spend permission(s) across ${totalApprovals} total approval(s).`;
  } else if (unlimitedApprovals > 0) {
    summary = `Found ${unlimitedApprovals} unlimited spend permission(s) to known protocols across ${totalApprovals} total approval(s).`;
  }

  const recommendations: ApprovalRecommendation[] = findings
    .filter(f => f.riskLevel === 'critical' || f.riskLevel === 'high')
    .map((f, idx) => ({
      id: `approval-risk-${f.tokenAddress}-${f.spenderAddress}-${idx}`,
      title: `${f.riskLevel.toUpperCase()} Risk: ${f.tokenSymbol} Spend Permission`,
      description: `${f.reason} Consider reviewing this permission in a trusted wallet or revoke interface.`,
      riskLevel: f.riskLevel,
      tokenSymbol: f.tokenSymbol,
      spenderAddress: f.spenderAddress,
      spenderLabel: f.spenderLabel,
      calls: [] as [],
      kind: "recommendation" as const,
    }));

  return {
    summary,
    totalApprovals,
    unlimitedApprovals,
    riskySpenderApprovals,
    findings,
    recommendations,
  };
}

export async function fetchInternalApprovals(address: string, chainEnv: string = 'sepolia'): Promise<{
  approvals: TokenApproval[];
  status: "connected" | "missing" | "failed" | "partial" | "disabled" | "rate_limited" | "budget_exhausted" | "temporarily_unavailable";
  provider: "moralis" | "alchemy" | "none" | "mock";
  tokenCount: number;
  unlimitedCount: number;
  riskySpenderCount: number;
  cache?: { status: CacheStatus; cacheAgeSeconds?: number; providerCalled: boolean; budgetExhausted: boolean; errorCode?: string; error?: string };
}> {
  const chainId = chainEnv === 'sepolia' ? 84532 : 8453;
  const { provider, statusCode, providerName } = getApprovalProviderFromEnv();

  if (providerName === 'none') {
    return {
      approvals: [],
      status: statusCode,
      provider: "none",
      tokenCount: 0,
      unlimitedCount: 0,
      riskySpenderCount: 0
    };
  }

  const orch = getProviderCacheOrchestratorFromEnv();
  const appKey = `provider:${providerName}:approvals:${chainId}:${address.toLowerCase()}`;
  const appRes = await cachedProviderCall<TokenApproval[]>({
    key: appKey,
    provider: providerName as ProviderName,
    chainId,
    ttlSeconds: orch.ttls.approvals,
    store: orch.store,
    budget: orch.budget,
    fetcher: () => provider.getTokenApprovals({ walletAddress: address, chainId }),
  }).catch((err: unknown): CachedCallResult<TokenApproval[]> => ({
    data: undefined,
    status: 'failed',
    fromCache: false,
    providerCalled: false,
    budgetExhausted: false,
    error: err instanceof Error ? err.message : String(err),
  }));
  const cache = {
    status: appRes.status,
    cacheAgeSeconds: appRes.cacheAgeSeconds,
    providerCalled: appRes.providerCalled,
    budgetExhausted: appRes.budgetExhausted,
    errorCode: appRes.errorCode,
    error: appRes.error,
  };

  const approvals = appRes.data || [];
  if (approvals.length > 0 || appRes.status === 'live' || appRes.status === 'cached') {
    const analysis = analyzeApprovalsForRisk(approvals);
    let status: "connected" | "missing" | "failed" | "partial" | "disabled" | "rate_limited" | "budget_exhausted" | "temporarily_unavailable" = statusCode;
    if (appRes.status === 'stale') status = 'partial';
    if (appRes.status === 'rate_limited' || appRes.status === 'budget_exhausted') status = appRes.status;
    return {
      approvals,
      status,
      provider: providerName,
      tokenCount: new Set(approvals.map(a => a.tokenAddress)).size || approvals.length,
      unlimitedCount: analysis.unlimitedApprovals,
      riskySpenderCount: analysis.riskySpenderApprovals,
      cache
    };
  }
  if (appRes.status === 'rate_limited' || appRes.status === 'budget_exhausted') {
    return {
      approvals: [],
      status: appRes.status,
      provider: providerName,
      tokenCount: 0,
      unlimitedCount: 0,
      riskySpenderCount: 0,
      cache
    };
  }
  return {
    approvals: [],
    status: appRes.budgetExhausted ? 'partial' : 'failed',
    provider: providerName,
    tokenCount: 0,
    unlimitedCount: 0,
    riskySpenderCount: 0,
    cache
  };
}

export function analyzePortfolioForRisk(
  portfolio: PortfolioData,
  walletAddress: string,
  chainEnv: string = 'mainnet-readonly'
): PortfolioRiskAnalysis {
  const findings: TokenFinding[] = [];
  const tokens = portfolio.tokens || [];
  const securityProviderName: TokenSecurityProviderName = portfolio.providers?.riskProvider || (portfolio.providers?.risk === 'connected' ? 'goplus' : 'none');
  let securityProviderStatus: "connected" | "missing" | "failed" | "partial" | "disabled" =
    securityProviderName === 'none'
      ? (portfolio.providers?.risk === 'disabled' ? 'disabled' : 'missing')
      : providerStatusToSecurityStatus(portfolio.providers?.risk || 'missing');
  const tokenContractCount = tokens.filter(t => t.address !== 'native' && t.symbol !== 'ETH').length;
  const securityCheckedTokenCount = tokens.filter(t => t.security && t.security.provider !== 'none' && t.security.status !== 'failed' && t.security.status !== 'unknown').length;
  if (securityProviderStatus === 'connected' && securityCheckedTokenCount === 0 && tokenContractCount > 0 && securityProviderName !== 'none') {
    securityProviderStatus = 'failed';
  } else if (securityProviderStatus === 'connected' && securityCheckedTokenCount < tokenContractCount) {
    securityProviderStatus = 'partial';
  }

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
    } else if (t.security?.status === 'failed' || (!t.security && securityProviderStatus !== 'connected')) {
      risk = "unknown";
      reason = securityProviderStatus === 'missing' || securityProviderStatus === 'disabled'
        ? "Token security provider is not configured, so contract-level checks are limited."
        : securityProviderStatus === 'partial'
          ? "Token security coverage is incomplete, so this contract-level result is unknown."
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
  const provider = portfolio.providers?.tokenBalancesProvider || (portfolio.providers?.tokenBalances !== 'missing' && portfolio.providers?.tokenBalances !== 'disabled' ? 'moralis' : 'none');
  const priceProvider = portfolio.providers?.prices === 'failed' ? 'failed' : (portfolio.providers?.priceProvider || portfolio.providers?.prices || "none");
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

  const securityHighRiskCount = tokens.filter(t => t.security?.status === 'high-risk').length;
  const securityWarningCount = tokens.filter(t => t.security?.status === 'warning').length;

  const securityCoverage: PortfolioRiskAnalysis['securityProvider']['coverage'] = securityCheckedTokenCount === 0
    ? 'unavailable'
    : securityProviderStatus === 'connected' && securityCheckedTokenCount >= tokenContractCount
      ? 'complete'
      : 'partial';
  const securityFailureReason = securityCoverage === 'complete'
    ? undefined
    : securityCoverage === 'partial'
      ? `Usable verdicts were returned for ${securityCheckedTokenCount} of ${tokenContractCount} token contracts.`
      : sanitizeSecurityFailureReason(
        portfolio.providerCallSummary?.risk?.note
          || `${portfolio.providerCallSummary?.risk?.errorCode || ''} ${securityProviderStatus}`,
      );

  let findingSummary: string;
  if (securityHighRiskCount > 0) {
    findingSummary = `Detected ${securityHighRiskCount} tokens with high-risk security flags and ${suspiciousTokenCount} suspicious or low-confidence tokens out of ${tokenCount} assets.`;
  } else if (suspiciousTokenCount > 0) {
    findingSummary = `Detected ${suspiciousTokenCount} low-confidence or suspicious tokens out of ${tokenCount} assets using available metadata.`;
  } else {
    findingSummary = `Reviewed ${tokenCount} Base portfolio assets using available metadata.`;
  }
  const coverageSummary = securityCoverage === 'complete'
    ? `Contract checks completed for ${securityCheckedTokenCount} token contracts.`
    : securityCoverage === 'partial'
      ? `Contract checks are incomplete. ${securityFailureReason}`
      : `Contract checks are unavailable. ${securityFailureReason}`;
  const summary = `${findingSummary} ${coverageSummary} No execution is possible in read-only mode.`;

  const isPriceMissing = portfolio.providers?.prices === "missing" || portfolio.providers?.prices === "disabled" || priceProvider === "none" || priceProvider === "missing";
  const isPriceFailed = portfolio.providers?.prices === "failed" || priceProvider === "failed";
  const priceStep = isPriceFailed
    ? "USD values unavailable; value ranking limited."
    : isPriceMissing
      ? "Price provider is not configured, so value-based ranking is limited."
      : "Ranked findings using available USD values.";

  const securityStep = securityCoverage === 'complete'
    ? `Contract checks completed for ${securityCheckedTokenCount} token contracts.`
    : securityCoverage === 'partial'
      ? `Contract checks are incomplete. ${securityFailureReason}`
      : `Contract checks are unavailable. ${securityFailureReason}`;

  const suggestedNextSteps: string[] = [];
  if (portfolio.providerCallSummary?.balances?.status === 'rate_limited') {
    suggestedNextSteps.push("Alchemy rate-limited. Showing cached/native balance data.");
  }
  if (isApprovalScannerUnavailableStatus(portfolio.approvalSummary?.status)) {
    suggestedNextSteps.push(APPROVAL_SCANNER_UNAVAILABLE_NOTE);
  }
  if (portfolio.providers?.tokenBalances === 'stale') {
    suggestedNextSteps.push(`Analysis used cached ${providerDisplayName(portfolio.providers?.tokenBalancesProvider)} token balances.`);
  }
  suggestedNextSteps.push(priceStep, securityStep);
  suggestedNextSteps.push(
    "Review permissions and verify token contracts before interacting.",
    "Avoid interacting with tokens that show high-risk flags or suspicious claim/URL labels.",
    "Use a trusted wallet interface to revoke approvals if needed; MioAgent will not auto-revoke or create transactions in read-only mode."
  );

  let approvalAnalysis: ApprovalRiskAnalysis | undefined;
  if (portfolio.approvalSummary?.requested) {
    if (isApprovalScannerUnavailableStatus(portfolio.approvalSummary.status)) {
      approvalAnalysis = {
        summary: APPROVAL_SCANNER_UNAVAILABLE_UI_NOTE,
        totalApprovals: 0,
        unlimitedApprovals: 0,
        riskySpenderApprovals: 0,
        findings: [],
        recommendations: [],
        status: portfolio.approvalSummary.status,
        provider: portfolio.approvalSummary.provider,
        scannerUnavailable: true,
        note: portfolio.approvalSummary.note || APPROVAL_SCANNER_UNAVAILABLE_NOTE,
      };
    } else {
      approvalAnalysis = analyzeApprovalsForRisk(portfolio.approvals || [], portfolio);
      approvalAnalysis.status = portfolio.approvalSummary.status;
      approvalAnalysis.provider = portfolio.approvalSummary.provider;
      approvalAnalysis.note = portfolio.approvalSummary.note;
    }
  }

  const overallRiskLevel: PortfolioRiskAnalysis['overallRiskLevel'] = findings.some(f => f.risk === 'high') || securityHighRiskCount > 0
    ? 'high'
    : findings.some(f => f.risk === 'medium') || securityWarningCount > 0
      ? 'medium'
      : securityCoverage !== 'complete' && tokenContractCount > 0
        ? 'unknown'
        : 'low';

  return {
    overallRiskLevel,
    summary,
    providerContext: portfolio.providerContext,
    totalTokens: tokenCount,
    approvalSummary: portfolio.approvalSummary,
    approvals: portfolio.approvalSummary?.requested ? (portfolio.approvals || []) : undefined,
    approvalFindings: approvalAnalysis?.findings,
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
      securityProvider: securityProviderName,
      dataFreshness: portfolio.dataFreshness,
      cacheAgeSeconds: portfolio.cacheAgeSeconds,
      providerBudgetStatus: portfolio.providerBudgetStatus,
      providerCallsMade: portfolio.providerCallsMade,
      snapshotTimestamp: portfolio.updatedAt
    },
    securityProvider: {
      provider: securityProviderName,
      status: securityProviderStatus,
      coverage: securityCoverage,
      failureReason: securityFailureReason,
    },
    tokenFindings: findings.slice(0, 10),
    suggestedNextSteps,
    approvalAnalysis
  };
}

export function buildPortfolioReviewAssistantContent(
  analysis: PortfolioRiskAnalysis,
  isReadonly: boolean,
): string {
  const checked = analysis.portfolioSnapshot.securityCheckedTokenCount || 0;
  const suspicious = analysis.portfolioSnapshot.suspiciousTokenCount;
  const monitored = Math.max(0, analysis.portfolioSnapshot.tokenCount - suspicious);
  const coverage = analysis.securityProvider.coverage;
  const securityCopy = checked > 0 && coverage === 'complete'
    ? `Contract checks returned ${checked} usable token-security verdict${checked === 1 ? '' : 's'}.`
    : checked > 0
      ? `Contract checks are incomplete: only ${checked} token contract${checked === 1 ? '' : 's'} returned a usable verdict.`
      : `Contract checks are unavailable: ${sanitizeSecurityFailureReason(analysis.securityProvider.failureReason || analysis.securityProvider.status)}`;
  return `I reviewed your Base token list and created a${isReadonly ? ' read-only' : ''} risk recommendation. ${securityCopy} I found ${suspicious} suspicious/low-confidence tokens and ${monitored} tokens worth monitoring.${isReadonly ? ' No transaction was executed.' : ''}`;
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

  const overallRisk = analysis.portfolioSnapshot.securityHighRiskCount > 0 || analysis.portfolioSnapshot.suspiciousTokenCount > 0
    ? "high"
    : analysis.securityProvider.coverage !== 'complete'
      ? "unknown"
      : "low";

  return {
    type: "recommendation",
    title: intent?.title || "Token Risk & Portfolio Review",
    instruction: message,
    reason: intent?.reason || `Automated risk analysis created by Agent Stream for: "${message}"`,
    expectedEffect: intent?.expectedEffect || "Analyze Base token list, filter spam/airdrop tokens, and flag any high-risk assets.",
    risk: isReadonly ? (overallRisk === 'low' ? "low" : "medium") : (overallRisk === 'unknown' ? "medium" : overallRisk),
    riskScore: analysis.portfolioSnapshot.securityHighRiskCount > 0 ? 85 : analysis.portfolioSnapshot.suspiciousTokenCount > 0 ? 75 : overallRisk === 'unknown' ? 50 : 15,
    chainMode: chainEnv,
    safetyState: isReadonly ? "blocked" : (canExecute ? "executable" : "blocked"),
    executable: canExecute,
    executionStatus: isReadonly ? "read-only" : (canExecute ? "executable" : "blocked"),
    calls: [],
    createdBy: intent?.createdBy || "agent-stream",
    walletAddress: walletAddress,
    providerContext: providerContext || {
      tokenBalances: analysis.portfolioSnapshot.provider,
      prices: analysis.portfolioSnapshot.priceProvider || "missing",
      risk: analysis.securityProvider.status,
      securityProvider: analysis.securityProvider.provider,
      approvals: analysis.providerContext?.approvalScanStatus || (analysis.approvalAnalysis ? "checked" : "not_requested"),
      approvalProvider: analysis.providerContext?.approvalProvider || analysis.providerContext?.approvalsProvider || "none"
    },
    analysis: analysis,
    approvalAnalysis: analysis.approvalAnalysis
  };
}
