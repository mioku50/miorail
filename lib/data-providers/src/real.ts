import { MoralisProvider, CoinGeckoProvider, DeFiLlamaProvider, GoPlusProvider, TokenBalancesProvider, TokenBalance, PriceProvider, TokenPrice } from './interfaces.js';

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

export class NoneTokenBalancesProvider implements TokenBalancesProvider {
  async getTokenBalances(_params: { address: string; chainId: number }): Promise<TokenBalance[]> {
    return [];
  }
}

export class AlchemyTokenBalancesProvider implements TokenBalancesProvider {
  constructor(private readonly apiKey?: string, private readonly customRpcUrl?: string) {}

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
    if (!res.ok) throw new Error(`Alchemy API error: ${res.statusText}`);
    const data = await res.json() as { result?: { tokenBalances?: Array<{ contractAddress: string; tokenBalance: string }> } };
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
        const metaData = await metaRes.json() as { result?: { symbol?: string; name?: string; decimals?: number; logo?: string } };
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
      } catch {
        // ignore individual metadata fetch error
      }
    }
    return results;
  }
}

export class MoralisTokenBalancesProvider implements TokenBalancesProvider {
  constructor(private readonly apiKey?: string) {}

  async getTokenBalances(params: { address: string; chainId: number }): Promise<TokenBalance[]> {
    if (!this.apiKey) throw new Error('Moralis API key missing');
    const chainParam = params.chainId === 84532 ? 'base%20sepolia' : 'base';
    const res = await fetch(`https://deep-index.moralis.io/api/v2.2/${params.address}/erc20?chain=${chainParam}`, {
      headers: {
        'X-API-Key': this.apiKey,
        'accept': 'application/json'
      }
    });
    if (!res.ok) throw new Error(`Moralis API error: ${res.statusText}`);
    const data = await res.json() as Array<{ token_address: string; balance: string; decimals: number; symbol: string; name?: string; logo?: string; possible_spam?: boolean; verified_contract?: boolean }>;
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
  }
}

export function getTokenBalancesProviderFromEnv(): { provider: TokenBalancesProvider; status: string; providerName: "moralis" | "alchemy" | "mock" | "none" } {
  const mode = (process.env.TOKEN_BALANCES_PROVIDER || 'none').toLowerCase();
  if (mode === 'none') {
    return { provider: new NoneTokenBalancesProvider(), status: 'Token balances provider not configured', providerName: 'none' };
  }
  if (mode === 'alchemy' || (!process.env.TOKEN_BALANCES_PROVIDER && (process.env.ALCHEMY_API_KEY || process.env.ALCHEMY_BASE_MAINNET_RPC_URL))) {
    if (!process.env.ALCHEMY_API_KEY && !process.env.ALCHEMY_BASE_MAINNET_RPC_URL) {
      return { provider: new NoneTokenBalancesProvider(), status: 'Token balances provider not configured', providerName: 'none' };
    }
    return { provider: new AlchemyTokenBalancesProvider(process.env.ALCHEMY_API_KEY, process.env.ALCHEMY_BASE_MAINNET_RPC_URL), status: 'Alchemy connected', providerName: 'alchemy' };
  }
  if (mode === 'moralis' || (!process.env.TOKEN_BALANCES_PROVIDER && process.env.MORALIS_API_KEY)) {
    if (!process.env.MORALIS_API_KEY) {
      return { provider: new NoneTokenBalancesProvider(), status: 'Token balances provider not configured', providerName: 'none' };
    }
    return { provider: new MoralisTokenBalancesProvider(process.env.MORALIS_API_KEY), status: 'Moralis connected', providerName: 'moralis' };
  }
  if (mode === 'mock') {
    const { MockTokenBalancesProvider } = require('./mocks.js');
    return { provider: new MockTokenBalancesProvider(), status: 'mock', providerName: 'mock' };
  }
  return { provider: new NoneTokenBalancesProvider(), status: 'Token balances provider not configured', providerName: 'none' };
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
      if (token.address) {
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
    if (!this.apiKey) throw new Error('Moralis API key missing');
    const chainParam = params.chainId === 84532 ? 'base%20sepolia' : 'base';
    const results: TokenPrice[] = [];

    for (const token of params.tokens) {
      let addr = token.address;
      if (!addr || token.symbol.toUpperCase() === 'ETH') {
        addr = '0x4200000000000000000000000000000000000006'; // Base WETH
      }
      try {
        const res = await fetch(`https://deep-index.moralis.io/api/v2.2/erc20/${addr}/price?chain=${chainParam}`, {
          headers: { 'X-API-Key': this.apiKey, 'accept': 'application/json' }
        });
        if (!res.ok) {
          if (res.status === 404 || res.status === 400) {
            results.push({ symbol: token.symbol, address: token.address, usdPrice: undefined, source: 'none', confidence: 'unknown' });
            continue;
          }
          throw new Error(`Moralis API error: ${res.statusText}`);
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
    return results;
  }
}

export function getPriceProviderFromEnv(): { provider: PriceProvider; status: string; providerName: "coingecko" | "moralis" | "none" | "mock" } {
  const mode = (process.env.PRICE_PROVIDER || 'none').toLowerCase();
  if (mode === 'none') {
    return { provider: new NonePriceProvider(), status: 'Price provider not configured', providerName: 'none' };
  }
  if (mode === 'coingecko' || (!process.env.PRICE_PROVIDER && process.env.COINGECKO_API_KEY)) {
    return { provider: new CoinGeckoPriceProvider(process.env.COINGECKO_API_KEY), status: 'CoinGecko connected', providerName: 'coingecko' };
  }
  if (mode === 'moralis' || (!process.env.PRICE_PROVIDER && process.env.MORALIS_API_KEY)) {
    if (!process.env.MORALIS_API_KEY) {
      return { provider: new NonePriceProvider(), status: 'Price provider not configured', providerName: 'none' };
    }
    return { provider: new MoralisPriceProvider(process.env.MORALIS_API_KEY), status: 'Moralis prices connected', providerName: 'moralis' };
  }
  if (mode === 'mock') {
    const { MockPriceProvider } = require('./mocks.js');
    return { provider: new MockPriceProvider(), status: 'mock', providerName: 'mock' };
  }
  return { provider: new NonePriceProvider(), status: 'Price provider not configured', providerName: 'none' };
}



