export interface MoralisProvider {
  getWalletTokenBalances(address: string): Promise<Array<{ tokenAddress: string; balance: string; decimals: number; symbol: string }>>;
}

export interface CoinGeckoProvider {
  getSimplePrice(ids: string[], vsCurrencies: string[]): Promise<Record<string, Record<string, number>>>;
}

export interface DeFiLlamaProvider {
  getProtocolTvl(protocol: string): Promise<number>;
}

export interface GoPlusProvider {
  tokenSecurityCheck(chainId: number, tokenAddress: string): Promise<Record<string, unknown>>;
}

export interface TokenBalance {
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
}

export interface TokenBalancesProvider {
  getTokenBalances(params: {
    address: string;
    chainId: number;
  }): Promise<TokenBalance[]>;
}

export class ProviderRateLimitError extends Error {
  readonly status = "rate_limited";
  readonly budgetExhausted = true;

  constructor(
    message: string,
    readonly provider: "alchemy" | "moralis" | "coingecko" | "goplus" | "unknown",
    readonly statusCode = 429,
    readonly code: string | number = 429,
  ) {
    super(message);
    this.name = "ProviderRateLimitError";
  }
}

export function isProviderRateLimitError(error: unknown): error is ProviderRateLimitError {
  const e = error as { name?: string; status?: string; statusCode?: number; code?: string | number; message?: string; budgetExhausted?: boolean } | null | undefined;
  if (!e) return false;
  if (e.name === "ProviderRateLimitError" || e.status === "rate_limited") return true;
  if (e.statusCode === 429 || e.code === 429 || e.code === "429") return true;
  return /rate[- ]?limit|too many requests|http 429/i.test(e.message || "");
}

export interface TokenPrice {
  symbol: string;
  address?: string;
  usdPrice?: string;
  source: "coingecko" | "moralis" | "alchemy" | "none";
  confidence: "high" | "medium" | "low" | "unknown";
}

export interface PriceProvider {
  getTokenPrices(params: {
    chainId: number;
    tokens: {
      symbol: string;
      address?: string;
    }[];
  }): Promise<TokenPrice[]>;
}

export type TokenSecurityProviderName = "goplus" | "none";

export type TokenSecurityStatus = "ok" | "warning" | "high-risk" | "unknown" | "failed";

export interface TokenSecurityFlags {
  isHoneypot?: boolean;
  isMintable?: boolean;
  isProxy?: boolean;
  isOpenSource?: boolean;
  hiddenOwner?: boolean;
  canTakeBackOwnership?: boolean;
  ownerCanChangeBalance?: boolean;
  hasBlacklist?: boolean;
  hasWhitelist?: boolean;
  tradingCooldown?: boolean;
  selfdestruct?: boolean;
  externalCall?: boolean;
  buyTax?: string;
  sellTax?: string;
  cannotSellAll?: boolean;
  isInDex?: boolean;
  holderCount?: string;
}

export interface TokenSecurityResult {
  address: string;
  provider: TokenSecurityProviderName;
  status: TokenSecurityStatus;
  flags: TokenSecurityFlags;
  rawRiskLabels: string[];
  summary: string;
}

export interface TokenSecurityProvider {
  getTokenSecurity(params: {
    chainId: number;
    tokenAddresses: string[];
  }): Promise<TokenSecurityResult[]>;
}

export interface TokenSecurityProviderEnvResult {
  provider: TokenSecurityProvider;
  status: string;
  statusCode: "connected" | "missing" | "failed" | "partial" | "disabled";
  providerName: TokenSecurityProviderName;
}

export interface TokenApproval {
  tokenAddress: string;
  tokenSymbol?: string;
  tokenName?: string;
  spenderAddress: string;
  spenderLabel?: string;
  allowanceRaw: string;
  allowanceFormatted?: string;
  allowanceUsd?: number;
  isUnlimited: boolean;
  lastUpdatedAt?: string;
  source: "moralis" | "alchemy" | "basescan" | "none";
}

export interface ApprovalProvider {
  getTokenApprovals(params: {
    walletAddress: string;
    chainId: number;
  }): Promise<TokenApproval[]>;
}

export interface ApprovalProviderEnvResult {
  provider: ApprovalProvider;
  status: string;
  statusCode: "connected" | "missing" | "failed" | "partial" | "disabled";
  providerName: "moralis" | "alchemy" | "none" | "mock";
}
