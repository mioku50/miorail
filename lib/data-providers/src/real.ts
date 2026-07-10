import {
  MoralisProvider,
  CoinGeckoProvider,
  DeFiLlamaProvider,
  GoPlusProvider,
  TokenBalancesProvider,
  TokenBalance,
  PriceProvider,
  TokenPrice,
  TokenSecurityProvider,
  TokenSecurityProviderEnvResult,
  TokenSecurityResult,
  TokenSecurityFlags,
  TokenSecurityStatus,
  ApprovalProvider,
  TokenApproval,
  ProviderRateLimitError,
  ProviderBudgetExhaustedError,
  isProviderRateLimitError
} from './interfaces.js';
import { MockPriceProvider, MockApprovalProvider, MockTokenBalancesProvider } from './mocks.js';

export class RealMoralisProvider implements MoralisProvider {
  constructor(private readonly apiKey: string) {}

  async getWalletTokenBalances(address: string) {
    if (!this.apiKey) throw new Error('Moralis API key missing');
    const res = await fetch(`https://deep-index.moralis.io/api/v2.2/${address}/erc20?chain=base`, {
        headers: {
            'X-API-Key': this.apiKey,
            'accept': 'application/json'
        }
    });
    if (!res.ok) throw new Error(`Moralis API error: ${res.statusText}`);
    const data = await res.json() as Array<{ token_address: string; balance: string; decimals: number; symbol: string }>;
    return data.map(d => ({
        tokenAddress: d.token_address,
        balance: d.balance,
        decimals: d.decimals,
        symbol: d.symbol
    }));
  }
}

export class RealCoinGeckoProvider implements CoinGeckoProvider {
  async getSimplePrice(ids: string[], vsCurrencies: string[]) {
    if (!ids.length || !vsCurrencies.length) return {};
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=${vsCurrencies.join(',')}`);
    if (!res.ok) throw new Error(`CoinGecko API error: ${res.statusText}`);
    return res.json() as Promise<Record<string, Record<string, number>>>;
  }
}

export class RealDeFiLlamaProvider implements DeFiLlamaProvider {
  async getProtocolTvl(protocol: string) {
    const res = await fetch(`https://api.llama.fi/tvl/${protocol}`);
    if (!res.ok) throw new Error(`DeFiLlama API error: ${res.statusText}`);
    const data = await res.json();
    return Number(data);
  }
}

export class RealGoPlusProvider implements GoPlusProvider {
  async tokenSecurityCheck(chainId: number, tokenAddress: string) {
    const res = await fetch(`https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${tokenAddress}`);
    if (!res.ok) throw new Error(`GoPlus API error: ${res.statusText}`);
    const data = await res.json() as { result: Record<string, Record<string, unknown>> };
    return data.result[tokenAddress.toLowerCase()] || {};
  }
}

const TOKEN_SECURITY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const TOKEN_SECURITY_SCAN_LIMIT = 50;
const ERC20_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

type TokenSecurityCacheEntry = {
  expiresAt: number;
  result: TokenSecurityResult;
};

const tokenSecurityCache = new Map<string, TokenSecurityCacheEntry>();
let tokenSecurityHealth: { providerName: 'goplus' | 'none'; statusCode: 'connected' | 'missing' | 'failed' | 'partial' | 'disabled' } = {
  providerName: 'none',
  statusCode: 'missing'
};

export function setTokenSecurityHealthStatus(statusCode: 'connected' | 'missing' | 'failed' | 'partial') {
  if (tokenSecurityHealth.providerName === 'goplus') {
    tokenSecurityHealth.statusCode = statusCode;
  }
}

export function clearTokenSecurityCacheForTests() {
  tokenSecurityCache.clear();
  tokenSecurityHealth = { providerName: 'none', statusCode: 'missing' };
}

function cacheKey(chainId: number, address: string) {
  return `token-security:goplus:${chainId}:${address.toLowerCase()}`;
}

function normalizeAddresses(addresses: string[]) {
  return Array.from(new Set(
    addresses
      .filter((a): a is string => typeof a === 'string')
      .map(a => a.trim().toLowerCase())
      .filter(a => ERC20_ADDRESS_RE.test(a))
  )).slice(0, TOKEN_SECURITY_SCAN_LIMIT);
}

function asBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true;
    if (normalized === '0' || normalized === 'false' || normalized === 'no') return false;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return String(value);
}

function parseTax(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value.replace('%', '').trim());
  if (!Number.isFinite(parsed)) return undefined;
  return parsed > 1 ? parsed / 100 : parsed;
}

function isHighTax(value?: string) {
  const parsed = parseTax(value);
  return parsed !== undefined && parsed >= 0.1;
}

function field(data: Record<string, unknown>, ...names: string[]) {
  for (const name of names) {
    if (data[name] !== undefined) return data[name];
  }
  return undefined;
}

export function mapGoPlusTokenSecurity(address: string, data: Record<string, unknown>): TokenSecurityResult {
  const flags: TokenSecurityFlags = {
    isHoneypot: asBoolean(field(data, 'is_honeypot', 'honeypot')),
    isMintable: asBoolean(field(data, 'is_mintable', 'mintable')),
    isProxy: asBoolean(field(data, 'is_proxy', 'proxy')),
    isOpenSource: asBoolean(field(data, 'is_open_source', 'open_source')),
    hiddenOwner: asBoolean(field(data, 'hidden_owner')),
    canTakeBackOwnership: asBoolean(field(data, 'can_take_back_ownership')),
    ownerCanChangeBalance: asBoolean(field(data, 'owner_change_balance', 'owner_can_change_balance')),
    hasBlacklist: asBoolean(field(data, 'is_blacklisted', 'blacklist', 'has_blacklist')),
    hasWhitelist: asBoolean(field(data, 'is_whitelisted', 'whitelist', 'has_whitelist')),
    tradingCooldown: asBoolean(field(data, 'trading_cooldown', 'cooldown')),
    selfdestruct: asBoolean(field(data, 'selfdestruct', 'self_destruct')),
    externalCall: asBoolean(field(data, 'external_call')),
    buyTax: asString(field(data, 'buy_tax')),
    sellTax: asString(field(data, 'sell_tax')),
    cannotSellAll: asBoolean(field(data, 'cannot_sell_all')),
    isInDex: asBoolean(field(data, 'is_in_dex', 'in_dex')),
    holderCount: asString(field(data, 'holder_count')),
  };

  const highRiskLabels: string[] = [];
  const warningLabels: string[] = [];

  if (flags.isHoneypot) highRiskLabels.push('Honeypot-like behavior');
  if (flags.cannotSellAll) highRiskLabels.push('Cannot sell all');
  if (flags.hasBlacklist) highRiskLabels.push('Blacklist enabled');
  if (flags.ownerCanChangeBalance) highRiskLabels.push('Owner can change balances');
  if (flags.hiddenOwner) highRiskLabels.push('Hidden owner');
  if (flags.canTakeBackOwnership) highRiskLabels.push('Owner can take back ownership');
  if (flags.selfdestruct) highRiskLabels.push('Selfdestruct capability');
  if (flags.externalCall) highRiskLabels.push('External call capability');
  if (isHighTax(flags.buyTax)) highRiskLabels.push(`High buy tax (${flags.buyTax})`);
  if (isHighTax(flags.sellTax)) highRiskLabels.push(`High sell tax (${flags.sellTax})`);

  if (flags.isProxy) warningLabels.push('Proxy contract');
  if (flags.isOpenSource === false) warningLabels.push('Source code not open');
  if (flags.isMintable) warningLabels.push('Mintable token');
  if (flags.hasWhitelist) warningLabels.push('Whitelist enabled');
  if (flags.tradingCooldown) warningLabels.push('Trading cooldown');
  if (flags.isInDex === false) warningLabels.push('No DEX/liquidity signal');

  let status: TokenSecurityStatus = 'unknown';
  if (highRiskLabels.length > 0) {
    status = 'high-risk';
  } else if (warningLabels.length > 0) {
    status = 'warning';
  } else if (Object.values(flags).some(v => v !== undefined)) {
    status = 'ok';
  }

  const rawRiskLabels = [...highRiskLabels, ...warningLabels];
  const summary = status === 'high-risk'
    ? `GoPlus reported high-risk contract flags: ${highRiskLabels.slice(0, 3).join(', ')}.`
    : status === 'warning'
      ? `GoPlus reported warning-level contract flags: ${warningLabels.slice(0, 3).join(', ')}.`
      : status === 'ok'
        ? 'No major warnings detected by configured providers.'
        : 'GoPlus returned insufficient token security data.';

  return {
    address: address.toLowerCase(),
    provider: 'goplus',
    status,
    flags,
    rawRiskLabels,
    summary
  };
}

function failedSecurityResult(address: string, summary = 'GoPlus token security check failed; contract-level risk is unknown.'): TokenSecurityResult {
  return {
    address: address.toLowerCase(),
    provider: 'goplus',
    status: 'failed',
    flags: {},
    rawRiskLabels: [],
    summary
  };
}

export class NoneTokenSecurityProvider implements TokenSecurityProvider {
  async getTokenSecurity(params: { chainId: number; tokenAddresses: string[] }): Promise<TokenSecurityResult[]> {
    return normalizeAddresses(params.tokenAddresses).map(address => ({
      address,
      provider: 'none' as const,
      status: 'unknown' as const,
      flags: {},
      rawRiskLabels: [],
      summary: 'Token security provider is not configured.'
    }));
  }
}

class MockTokenSecurityProvider implements TokenSecurityProvider {
  async getTokenSecurity(params: { chainId: number; tokenAddresses: string[] }): Promise<TokenSecurityResult[]> {
    return normalizeAddresses(params.tokenAddresses).map(address => ({
      address,
      provider: 'goplus' as const,
      status: 'ok' as const,
      flags: {
        isOpenSource: true,
        isProxy: false,
        isMintable: false,
        isHoneypot: false,
      },
      rawRiskLabels: [],
      summary: 'No major warnings detected by configured providers.'
    }));
  }
}

export class GoPlusTokenSecurityProvider implements TokenSecurityProvider {
  constructor(private readonly apiKey?: string, private readonly timeoutMs = 6000) {}

  async getTokenSecurity(params: { chainId: number; tokenAddresses: string[] }): Promise<TokenSecurityResult[]> {
    const addresses = normalizeAddresses(params.tokenAddresses);
    if (addresses.length === 0) return [];

    const now = Date.now();
    const results = new Map<string, TokenSecurityResult>();
    const missing: string[] = [];

    for (const address of addresses) {
      const cached = tokenSecurityCache.get(cacheKey(params.chainId, address));
      if (cached && cached.expiresAt > now) {
        results.set(address, cached.result);
      } else {
        missing.push(address);
      }
    }

    if (missing.length > 0) {
      const fetched = await this.fetchTokenSecurity(params.chainId, missing);
      for (const result of fetched) {
        results.set(result.address, result);
        if (result.status !== 'failed') {
          tokenSecurityCache.set(cacheKey(params.chainId, result.address), {
            expiresAt: Date.now() + TOKEN_SECURITY_CACHE_TTL_MS,
            result
          });
        }
      }
    }

    return addresses.map(address => results.get(address) || failedSecurityResult(address));
  }

  private async fetchTokenSecurity(chainId: number, addresses: string[]): Promise<TokenSecurityResult[]> {
    const url = new URL(`https://api.gopluslabs.io/api/v1/token_security/${chainId}`);
    url.searchParams.set('contract_addresses', addresses.join(','));

    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
      headers['X-API-Key'] = this.apiKey;
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url.toString(), {
          headers,
          signal: AbortSignal.timeout(this.timeoutMs)
        });
        if (!res.ok) {
          if (attempt === 0 && (res.status === 408 || res.status === 429 || res.status >= 500)) {
            continue;
          }
          throw new Error(`GoPlus API error: ${res.statusText || res.status}`);
        }
        const data = await res.json() as { result?: Record<string, Record<string, unknown>> };
        const rawResults = data.result || {};
        tokenSecurityHealth = { providerName: 'goplus', statusCode: 'connected' };
        return addresses.map(address => mapGoPlusTokenSecurity(address, rawResults[address.toLowerCase()] || {}));
      } catch (err) {
        if (attempt === 0) continue;
        tokenSecurityHealth = { providerName: 'goplus', statusCode: 'failed' };
        return addresses.map(address => failedSecurityResult(address, err instanceof Error ? err.message : undefined));
      }
    }

    tokenSecurityHealth = { providerName: 'goplus', statusCode: 'failed' };
    return addresses.map(address => failedSecurityResult(address));
  }
}

export function getTokenSecurityProviderFromEnv(): TokenSecurityProviderEnvResult {
  const mode = (process.env.TOKEN_SECURITY_PROVIDER || 'none').toLowerCase();
  if (mode === 'none') {
    // "disabled" = explicitly turned off via *_PROVIDER=none; "missing" = unset / not configured.
    const explicitNone = typeof process.env.TOKEN_SECURITY_PROVIDER === 'string'
      && process.env.TOKEN_SECURITY_PROVIDER.trim().toLowerCase() === 'none';
    const statusCode = explicitNone ? 'disabled' : 'missing';
    tokenSecurityHealth = { providerName: 'none', statusCode };
    return { provider: new NoneTokenSecurityProvider(), status: 'Token security provider not configured', statusCode, providerName: 'none' };
  }
  if (mode === 'goplus') {
    if (tokenSecurityHealth.providerName !== 'goplus') {
      // Configuration is not proof of operational health. Report missing until
      // a real token-level request succeeds, then keep the shared health result
      // so Status, Stream and execution guards cannot contradict each other.
      tokenSecurityHealth = { providerName: 'goplus', statusCode: 'missing' };
    }
    const statusCode = tokenSecurityHealth.statusCode;
    const statusText = statusCode === 'failed'
      ? 'GoPlus failed'
      : statusCode === 'partial'
        ? 'GoPlus partial'
        : statusCode === 'connected'
          ? 'GoPlus connected'
          : 'GoPlus configured; awaiting successful scan';
    return { provider: new GoPlusTokenSecurityProvider(process.env.GOPLUS_API_KEY), status: statusText, statusCode, providerName: 'goplus' };
  }
  if (mode === 'mock') {
    return { provider: new MockTokenSecurityProvider(), status: 'mock', statusCode: 'connected', providerName: 'goplus' };
  }
  tokenSecurityHealth = { providerName: 'none', statusCode: 'missing' };
  return { provider: new NoneTokenSecurityProvider(), status: 'Token security provider not configured', statusCode: 'missing', providerName: 'none' };
}

export class NoneTokenBalancesProvider implements TokenBalancesProvider {
  async getTokenBalances(_params: { address: string; chainId: number }): Promise<TokenBalance[]> {
    return [];
  }
}

export class AlchemyTokenBalancesProvider implements TokenBalancesProvider {
  constructor(private readonly apiKey?: string, private readonly customRpcUrl?: string) {}

  private async parseAlchemyResponse<T>(res: Response, operation: string): Promise<T> {
    let data: any;
    try {
      data = await res.json();
    } catch {
      // The status-based error path below still handles non-JSON responses.
    }
    if (res.status === 429 || data?.error?.code === 429 || data?.error?.code === '429') {
      const message = data?.error?.message || res.statusText || `Alchemy ${operation} rate limited`;
      throw new ProviderRateLimitError(`Alchemy rate limited: ${message}`, 'alchemy', 429, data?.error?.code || 429);
    }
    if (!res.ok) {
      throw new Error(`Alchemy API error: ${res.statusText || res.status}`);
    }
    if (data?.error) {
      throw new Error(`Alchemy JSON-RPC error: ${data.error.message || data.error.code || 'unknown error'}`);
    }
    return data as T;
  }

  async getTokenBalances(params: { address: string; chainId: number }): Promise<TokenBalance[]> {
    let rpcUrl = this.customRpcUrl;
    if (!rpcUrl) {
      if (!this.apiKey) throw new Error('Alchemy API key or custom RPC URL missing');
      if (params.chainId === 8453) {
        rpcUrl = `https://base-mainnet.g.alchemy.com/v2/${this.apiKey}`;
      } else if (params.chainId === 84532) {
        rpcUrl = `https://base-sepolia.g.alchemy.com/v2/${this.apiKey}`;
      } else {
        throw new Error(`Unsupported chainId for Alchemy provider: ${params.chainId}`);
      }
    }

    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'alchemy_getTokenBalances',
        params: [params.address, 'erc20']
      })
    });
    const data = await this.parseAlchemyResponse<{ result?: { tokenBalances?: Array<{ contractAddress: string; tokenBalance: string }> } }>(res, 'token balances');
    const rawBalances = data.result?.tokenBalances || [];
    const nonZero = rawBalances.filter(b => b.tokenBalance && b.tokenBalance !== '0x0000000000000000000000000000000000000000000000000000000000000000' && b.tokenBalance !== '0x0' && b.tokenBalance !== '0');

    const results: TokenBalance[] = [];
    for (const item of nonZero.slice(0, 15)) {
      try {
        const metaRes = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'alchemy_getTokenMetadata',
            params: [item.contractAddress]
          })
        });
        const metaData = await this.parseAlchemyResponse<{ result?: { symbol?: string; name?: string; decimals?: number; logo?: string } }>(metaRes, 'token metadata');
        const meta = metaData.result || {};
        const decimals = typeof meta.decimals === 'number' ? meta.decimals : 18;
        const balanceBigInt = BigInt(item.tokenBalance);
        const symbol = meta.symbol || 'ERC20';
        const balanceFormatted = (Number(balanceBigInt) / Math.pow(10, decimals)).toFixed(4);
        results.push({
          symbol,
          name: meta.name || symbol,
          address: item.contractAddress,
          balance: balanceBigInt.toString(),
          balanceFormatted,
          decimals,
          logoUrl: meta.logo || undefined,
          verified: false,
          possibleSpam: false
        });
      } catch (err) {
        if (isProviderRateLimitError(err)) throw err;
        // ignore individual metadata fetch error
      }
    }
    return results;
  }
}

export function getTokenBalancesFallbackProviderFromEnv(): { provider: TokenBalancesProvider; status: string; statusCode: "connected" | "missing" | "disabled"; providerName: "moralis" | "none" } {
  const mode = (process.env.TOKEN_BALANCES_FALLBACK_PROVIDER || 'none').toLowerCase();
  if (mode === 'none') {
    return { provider: new NoneTokenBalancesProvider(), status: 'Token balances fallback disabled', statusCode: 'disabled', providerName: 'none' };
  }
  if (mode === 'moralis') {
    if (!process.env.MORALIS_API_KEY) {
      return { provider: new NoneTokenBalancesProvider(), status: 'Moralis fallback provider not configured', statusCode: 'missing', providerName: 'moralis' };
    }
    return { provider: new MoralisTokenBalancesProvider(process.env.MORALIS_API_KEY), status: 'Moralis fallback connected', statusCode: 'connected', providerName: 'moralis' };
  }
  return { provider: new NoneTokenBalancesProvider(), status: 'Token balances fallback disabled', statusCode: 'disabled', providerName: 'none' };
}

function logMoralisDiagnostics(params: {
  endpointType: 'balances' | 'prices' | 'approvals';
  walletAddress?: string;
  chainId: number;
  statusCode?: number;
  tokenCount?: number;
  durationMs: number;
  errorMessage?: string;
}) {
  const shortAddr = params.walletAddress ? `${params.walletAddress.substring(0, 6)}...${params.walletAddress.substring(params.walletAddress.length - 4)}` : undefined;
  const safeError = params.errorMessage ? params.errorMessage.replace(/([A-Za-z0-9_-]{20,})/g, '[REDACTED]') : undefined;
  console.log(`[Moralis Diagnostics] endpoint=${params.endpointType} chainId=${params.chainId}${shortAddr ? ` wallet=${shortAddr}` : ''}${params.statusCode !== undefined ? ` status=${params.statusCode}` : ''}${params.tokenCount !== undefined ? ` count=${params.tokenCount}` : ''} durationMs=${params.durationMs}${safeError ? ` error="${safeError}"` : ''}`);
}

async function readMoralisErrorBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    try {
      return await res.text();
    } catch {
      return undefined;
    }
  }
}

function moralisErrorText(body: unknown, fallback: string): string {
  if (!body) return fallback;
  if (typeof body === 'string') return body || fallback;
  if (typeof body !== 'object') return fallback;
  const obj = body as Record<string, unknown>;
  const candidates = [
    obj.message,
    obj.error,
    obj.details,
    obj.detail,
    typeof obj.error === 'object' && obj.error ? (obj.error as Record<string, unknown>).message : undefined,
  ];
  const found = candidates.find((value) => typeof value === 'string' && value.trim() !== '');
  return found ? String(found) : fallback;
}

function isMoralisBudgetText(text: string): boolean {
  return /quota|compute[ -]?unit|cu\b|monthly limit|plan limit|usage limit|budget|credits? exhausted|insufficient credits|payment required|rate[- ]?limit|too many requests/i.test(text);
}

function throwClassifiedMoralisApprovalError(statusCode: number, statusText: string, body: unknown, hasApiKey: boolean): never {
  const rawMessage = moralisErrorText(body, statusText || String(statusCode));
  const message = `Moralis approval scanner unavailable: ${rawMessage}`;
  if (statusCode === 429) {
    throw new ProviderRateLimitError(message, 'moralis', statusCode, 'moralis_rate_limited', 'moralis_rate_limited');
  }
  if (hasApiKey && (statusCode === 401 || statusCode === 402 || statusCode === 403)) {
    const errorCode = statusCode === 402 || isMoralisBudgetText(rawMessage)
      ? 'moralis_budget_exhausted'
      : 'moralis_auth_or_budget';
    throw new ProviderBudgetExhaustedError(message, 'moralis', statusCode, errorCode, errorCode);
  }
  throw new Error(`Moralis API error: ${statusText || statusCode}`);
}

export class MoralisTokenBalancesProvider implements TokenBalancesProvider {
  constructor(private readonly apiKey?: string) {}

  async getTokenBalances(params: { address: string; chainId: number }): Promise<TokenBalance[]> {
    const startTime = Date.now();
    if (!this.apiKey) {
      logMoralisDiagnostics({ endpointType: 'balances', walletAddress: params.address, chainId: params.chainId, durationMs: Date.now() - startTime, errorMessage: 'Moralis API key missing' });
      throw new Error('Moralis API key missing');
    }
    const chainParam = params.chainId === 84532 ? 'base%20sepolia' : 'base';
    try {
      const res = await fetch(`https://deep-index.moralis.io/api/v2.2/${params.address}/erc20?chain=${chainParam}`, {
        headers: {
          'X-API-Key': this.apiKey,
          'accept': 'application/json'
        }
      });
      if (!res.ok) {
        throw new Error(`Moralis API error: ${res.statusText || res.status}`);
      }
      const data = await res.json() as Array<{ token_address: string; balance: string; decimals: number; symbol: string; name?: string; logo?: string; possible_spam?: boolean; verified_contract?: boolean }>;
      const durationMs = Date.now() - startTime;
      logMoralisDiagnostics({ endpointType: 'balances', walletAddress: params.address, chainId: params.chainId, statusCode: res.status, tokenCount: data.length, durationMs });
      return data.map(d => {
        const decimals = typeof d.decimals === 'number' ? d.decimals : 18;
        const balanceBigInt = BigInt(d.balance || '0');
        const symbol = d.symbol || 'ERC20';
        return {
          symbol,
          name: d.name || symbol,
          address: d.token_address,
          balance: balanceBigInt.toString(),
          balanceFormatted: (Number(balanceBigInt) / Math.pow(10, decimals)).toFixed(4),
          decimals,
          logoUrl: d.logo || undefined,
          verified: d.verified_contract || false,
          possibleSpam: d.possible_spam || false
        };
      });
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      logMoralisDiagnostics({ endpointType: 'balances', walletAddress: params.address, chainId: params.chainId, durationMs, errorMessage: err?.message || 'Unknown error' });
      throw err;
    }
  }
}

export function getTokenBalancesProviderFromEnv(): { provider: TokenBalancesProvider; status: string; statusCode: "connected" | "missing" | "disabled"; providerName: "moralis" | "alchemy" | "mock" | "none" } {
  const mode = (process.env.TOKEN_BALANCES_PROVIDER || 'alchemy').toLowerCase();
  if (mode === 'none') {
    // "disabled" = explicitly turned off via TOKEN_BALANCES_PROVIDER=none; "missing" = unset / key absent.
    const explicitNone = typeof process.env.TOKEN_BALANCES_PROVIDER === 'string'
      && process.env.TOKEN_BALANCES_PROVIDER.trim().toLowerCase() === 'none';
    return { provider: new NoneTokenBalancesProvider(), status: 'Token balances provider not configured', statusCode: explicitNone ? 'disabled' : 'missing', providerName: 'none' };
  }
  if (mode === 'alchemy') {
    if (!process.env.ALCHEMY_API_KEY && !process.env.ALCHEMY_BASE_MAINNET_RPC_URL) {
      return { provider: new NoneTokenBalancesProvider(), status: 'Token balances provider not configured', statusCode: 'missing', providerName: 'alchemy' };
    }
    return { provider: new AlchemyTokenBalancesProvider(process.env.ALCHEMY_API_KEY, process.env.ALCHEMY_BASE_MAINNET_RPC_URL), status: 'Alchemy connected', statusCode: 'connected', providerName: 'alchemy' };
  }
  if (mode === 'moralis') {
    if (!process.env.MORALIS_API_KEY) {
      return { provider: new NoneTokenBalancesProvider(), status: 'Token balances provider not configured', statusCode: 'missing', providerName: 'moralis' };
    }
    return { provider: new MoralisTokenBalancesProvider(process.env.MORALIS_API_KEY), status: 'Moralis connected', statusCode: 'connected', providerName: 'moralis' };
  }
  if (mode === 'mock') {
    return { provider: new MockTokenBalancesProvider(), status: 'mock', statusCode: 'connected', providerName: 'mock' };
  }
  return { provider: new NoneTokenBalancesProvider(), status: 'Token balances provider not configured', statusCode: 'missing', providerName: 'none' };
}

export class NonePriceProvider implements PriceProvider {
  async getTokenPrices(params: { chainId: number; tokens: { symbol: string; address?: string }[] }): Promise<TokenPrice[]> {
    return params.tokens.map(t => ({ symbol: t.symbol, address: t.address, usdPrice: undefined, source: 'none' as const, confidence: 'unknown' as const }));
  }
}

export class CoinGeckoPriceProvider implements PriceProvider {
  constructor(private readonly apiKey?: string) {}

  async getTokenPrices(params: { chainId: number; tokens: { symbol: string; address?: string }[] }): Promise<TokenPrice[]> {
    const results: TokenPrice[] = [];
    const contractAddresses: string[] = [];
    const addressToToken: Record<string, { symbol: string; address?: string }> = {};

    for (const token of params.tokens) {
      if (token.address && /^0x[a-fA-F0-9]{40}$/.test(token.address)) {
        contractAddresses.push(token.address.toLowerCase());
        addressToToken[token.address.toLowerCase()] = token;
      }
    }

    let contractPrices: Record<string, Record<string, number>> = {};
    if (contractAddresses.length > 0) {
      const url = new URL('https://api.coingecko.com/api/v3/simple/token_price/base');
      url.searchParams.set('contract_addresses', contractAddresses.join(','));
      url.searchParams.set('vs_currencies', 'usd');
      if (this.apiKey) {
        url.searchParams.set('x_cg_demo_api_key', this.apiKey);
      }
      const res = await fetch(url.toString());
      if (!res.ok) {
        throw new Error(`CoinGecko API error: ${res.statusText}`);
      }
      contractPrices = await res.json() as Record<string, Record<string, number>>;
    }

    let ethPrice: number | undefined;
    const hasEth = params.tokens.some(t => !t.address || t.symbol.toUpperCase() === 'ETH' || t.symbol.toUpperCase() === 'WETH');
    if (hasEth) {
      try {
        const url = new URL('https://api.coingecko.com/api/v3/simple/price');
        url.searchParams.set('ids', 'ethereum,weth');
        url.searchParams.set('vs_currencies', 'usd');
        if (this.apiKey) url.searchParams.set('x_cg_demo_api_key', this.apiKey);
        const res = await fetch(url.toString());
        if (res.ok) {
          const data = await res.json() as Record<string, Record<string, number>>;
          ethPrice = data.ethereum?.usd || data.weth?.usd;
        }
      } catch {
        // ignore individual eth price failure if contract prices succeeded
      }
    }

    for (const token of params.tokens) {
      if (!token.address || token.symbol.toUpperCase() === 'ETH') {
        if (ethPrice !== undefined) {
          results.push({ symbol: token.symbol, address: token.address, usdPrice: ethPrice.toString(), source: 'coingecko', confidence: 'high' });
        } else {
          results.push({ symbol: token.symbol, address: token.address, usdPrice: undefined, source: 'none', confidence: 'unknown' });
        }
      } else {
        const lowerAddr = token.address.toLowerCase();
        const priceData = contractPrices[lowerAddr];
        if (priceData && typeof priceData.usd === 'number') {
          results.push({ symbol: token.symbol, address: token.address, usdPrice: priceData.usd.toString(), source: 'coingecko', confidence: 'high' });
        } else if (token.symbol.toUpperCase() === 'WETH' && ethPrice !== undefined) {
          results.push({ symbol: token.symbol, address: token.address, usdPrice: ethPrice.toString(), source: 'coingecko', confidence: 'high' });
        } else {
          results.push({ symbol: token.symbol, address: token.address, usdPrice: undefined, source: 'none', confidence: 'unknown' });
        }
      }
    }

    return results;
  }
}

export class MoralisPriceProvider implements PriceProvider {
  constructor(private readonly apiKey?: string) {}

  async getTokenPrices(params: { chainId: number; tokens: { symbol: string; address?: string }[] }): Promise<TokenPrice[]> {
    const startTime = Date.now();
    if (!this.apiKey) {
      logMoralisDiagnostics({ endpointType: 'prices', chainId: params.chainId, durationMs: Date.now() - startTime, errorMessage: 'Moralis API key missing' });
      throw new Error('Moralis API key missing');
    }
    const chainParam = params.chainId === 84532 ? 'base%20sepolia' : 'base';
    const results: TokenPrice[] = [];
    let lastStatus: number | undefined = undefined;

    try {
      for (const token of params.tokens) {
        let addr = token.address;
        if (!addr || token.symbol.toUpperCase() === 'ETH') {
          addr = '0x4200000000000000000000000000000000000006'; // Base WETH
        }
        try {
          const res = await fetch(`https://deep-index.moralis.io/api/v2.2/erc20/${addr}/price?chain=${chainParam}`, {
            headers: { 'X-API-Key': this.apiKey, 'accept': 'application/json' }
          });
          lastStatus = res.status;
          if (!res.ok) {
            if (res.status === 404 || res.status === 400) {
              results.push({ symbol: token.symbol, address: token.address, usdPrice: undefined, source: 'none', confidence: 'unknown' });
              continue;
            }
            throw new Error(`Moralis API error: ${res.statusText || res.status}`);
          }
          const data = await res.json() as { usdPrice?: number };
          if (typeof data.usdPrice === 'number') {
            results.push({ symbol: token.symbol, address: token.address, usdPrice: data.usdPrice.toString(), source: 'moralis', confidence: 'high' });
          } else {
            results.push({ symbol: token.symbol, address: token.address, usdPrice: undefined, source: 'none', confidence: 'unknown' });
          }
        } catch (err: any) {
          if (err.message?.includes('Moralis API error')) {
            throw err;
          }
          results.push({ symbol: token.symbol, address: token.address, usdPrice: undefined, source: 'none', confidence: 'unknown' });
        }
      }
      const durationMs = Date.now() - startTime;
      logMoralisDiagnostics({ endpointType: 'prices', chainId: params.chainId, statusCode: lastStatus, tokenCount: results.length, durationMs });
      return results;
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      logMoralisDiagnostics({ endpointType: 'prices', chainId: params.chainId, statusCode: lastStatus, durationMs, errorMessage: err?.message || 'Unknown error' });
      throw err;
    }
  }
}

export function getPriceProviderFromEnv(): { provider: PriceProvider; status: string; statusCode: "connected" | "missing" | "disabled"; providerName: "coingecko" | "moralis" | "none" | "mock" } {
  const mode = (process.env.PRICE_PROVIDER || 'coingecko').toLowerCase();
  if (mode === 'none') {
    // "disabled" = explicitly turned off via PRICE_PROVIDER=none; "missing" = unset / key absent.
    const explicitNone = typeof process.env.PRICE_PROVIDER === 'string'
      && process.env.PRICE_PROVIDER.trim().toLowerCase() === 'none';
    return { provider: new NonePriceProvider(), status: 'Price provider not configured', statusCode: explicitNone ? 'disabled' : 'missing', providerName: 'none' };
  }
  if (mode === 'coingecko') {
    return { provider: new CoinGeckoPriceProvider(process.env.COINGECKO_API_KEY), status: 'CoinGecko connected', statusCode: 'connected', providerName: 'coingecko' };
  }
  if (mode === 'moralis') {
    if (!process.env.MORALIS_API_KEY) {
      return { provider: new NonePriceProvider(), status: 'Price provider not configured', statusCode: 'missing', providerName: 'moralis' };
    }
    return { provider: new MoralisPriceProvider(process.env.MORALIS_API_KEY), status: 'Moralis prices connected', statusCode: 'connected', providerName: 'moralis' };
  }
  if (mode === 'mock') {
    return { provider: new MockPriceProvider(), status: 'mock', statusCode: 'connected', providerName: 'mock' };
  }
  return { provider: new NonePriceProvider(), status: 'Price provider not configured', statusCode: 'missing', providerName: 'none' };
}

function checkIsUnlimited(raw: string): boolean {
  if (!raw || raw === '0') return false;
  if (raw.toLowerCase() === 'unlimited' || raw.includes('115792089237316195423570985008687907853269984665640564039457584007913129639935')) return true;
  try {
    const val = BigInt(raw);
    const limit30 = BigInt('1000000000000000000000000000000'); // 1e30
    return val >= limit30;
  } catch {
    return false;
  }
}

export class NoneApprovalProvider implements ApprovalProvider {
  async getTokenApprovals(_params: { walletAddress: string; chainId: number }): Promise<TokenApproval[]> {
    return [];
  }
}

export class MoralisApprovalProvider implements ApprovalProvider {
  constructor(private readonly apiKey: string) {}

  async getTokenApprovals(params: { walletAddress: string; chainId: number }): Promise<TokenApproval[]> {
    if (!this.apiKey) throw new Error('Moralis API key missing');
    const startTime = Date.now();
    let lastStatus = 0;
    const chainParam = params.chainId === 84532 ? 'base%20sepolia' : 'base';
    try {
      const res = await fetch(`https://deep-index.moralis.io/api/v2.2/wallets/${params.walletAddress}/approvals?chain=${chainParam}`, {
        headers: {
          'X-API-Key': this.apiKey,
          'accept': 'application/json'
        }
      });
      lastStatus = res.status;
      if (!res.ok) {
        const errorBody = await readMoralisErrorBody(res);
        throwClassifiedMoralisApprovalError(res.status, res.statusText || String(res.status), errorBody, Boolean(this.apiKey));
      }
      const data = await res.json() as any;
      const list = Array.isArray(data) ? data : (Array.isArray(data?.result) ? data.result : []);
      const results: TokenApproval[] = list.map((item: any) => {
        const tokenAddress = (item.token?.address || item.token_address || item.contract_address || '').toLowerCase();
        const tokenSymbol = item.token?.symbol || item.token_symbol || item.symbol || 'UNKNOWN';
        const tokenName = item.token?.name || item.token_name || item.name || 'Unknown Token';
        const decimals = Number(item.token?.decimals || item.token_decimals || item.decimals || 18);
        const spenderAddress = (item.spender?.address || item.spender_address || (typeof item.spender === 'string' ? item.spender : '') || '').toLowerCase();
        const spenderLabel = item.spender?.label || item.spender?.name || item.spender_label || item.spender_name || undefined;
        const allowanceRaw = (item.value || item.allowance || item.allowance_raw || '0').toString();
        const isUnlim = checkIsUnlimited(allowanceRaw);
        let allowanceFormatted = item.value_formatted || item.allowance_formatted;
        if (!allowanceFormatted || allowanceFormatted === allowanceRaw) {
          if (isUnlim) {
            allowanceFormatted = 'Unlimited';
          } else {
            try {
              const val = Number(allowanceRaw) / Math.pow(10, !isNaN(decimals) && decimals > 0 ? decimals : 18);
              allowanceFormatted = isNaN(val) ? allowanceRaw : val.toFixed(4);
            } catch {
              allowanceFormatted = allowanceRaw;
            }
          }
        }
        const lastUpdatedAt = item.block_timestamp || item.updated_at || item.last_updated_at || undefined;
        return {
          tokenAddress,
          tokenSymbol,
          tokenName,
          spenderAddress,
          spenderLabel,
          allowanceRaw,
          allowanceFormatted,
          isUnlimited: isUnlim,
          lastUpdatedAt,
          source: 'moralis' as const
        };
      });
      const durationMs = Date.now() - startTime;
      logMoralisDiagnostics({ endpointType: 'approvals', walletAddress: params.walletAddress, chainId: params.chainId, statusCode: lastStatus, tokenCount: results.length, durationMs });
      return results;
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      logMoralisDiagnostics({ endpointType: 'approvals', walletAddress: params.walletAddress, chainId: params.chainId, statusCode: lastStatus, durationMs, errorMessage: err?.message || 'Unknown error' });
      throw err;
    }
  }
}

export function getApprovalProviderFromEnv(): { provider: ApprovalProvider; status: string; statusCode: "connected" | "missing" | "failed" | "partial" | "disabled"; providerName: "moralis" | "alchemy" | "none" | "mock" } {
  const mode = (process.env.APPROVAL_PROVIDER || 'none').toLowerCase();
  if (mode === 'none') {
    // "disabled" = explicitly turned off via APPROVAL_PROVIDER=none; "missing" = unset / key absent.
    const explicitNone = typeof process.env.APPROVAL_PROVIDER === 'string'
      && process.env.APPROVAL_PROVIDER.trim().toLowerCase() === 'none';
    return { provider: new NoneApprovalProvider(), status: 'Approval provider not configured', statusCode: explicitNone ? 'disabled' : 'missing', providerName: 'none' };
  }
  if (mode === 'moralis' || (!process.env.APPROVAL_PROVIDER && process.env.MORALIS_API_KEY)) {
    if (!process.env.MORALIS_API_KEY) {
      return { provider: new NoneApprovalProvider(), status: 'Approval provider not configured', statusCode: 'missing', providerName: 'moralis' };
    }
    return { provider: new MoralisApprovalProvider(process.env.MORALIS_API_KEY), status: 'Moralis approvals connected', statusCode: 'connected', providerName: 'moralis' };
  }
  if (mode === 'mock') {
    return { provider: new MockApprovalProvider(), status: 'mock', statusCode: 'connected', providerName: 'mock' };
  }
  return { provider: new NoneApprovalProvider(), status: 'Approval provider not configured', statusCode: 'missing', providerName: 'none' };
}
