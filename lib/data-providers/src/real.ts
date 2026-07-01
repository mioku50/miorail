import { MoralisProvider, CoinGeckoProvider, DeFiLlamaProvider, GoPlusProvider, TokenBalancesProvider, TokenBalance } from './interfaces.js';

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
        const metaData = await metaRes.json() as { result?: { symbol?: string; decimals?: number; logo?: string } };
        const meta = metaData.result || {};
        const decimals = typeof meta.decimals === 'number' ? meta.decimals : 18;
        const balanceBigInt = BigInt(item.tokenBalance);
        const symbol = meta.symbol || 'ERC20';
        const balanceFormatted = (Number(balanceBigInt) / Math.pow(10, decimals)).toFixed(4);
        results.push({
          symbol,
          address: item.contractAddress,
          balance: balanceBigInt.toString(),
          balanceFormatted,
          decimals,
          logoUrl: meta.logo || undefined
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
    const data = await res.json() as Array<{ token_address: string; balance: string; decimals: number; symbol: string; logo?: string }>;
    return data.map(d => {
      const decimals = typeof d.decimals === 'number' ? d.decimals : 18;
      const balanceBigInt = BigInt(d.balance || '0');
      return {
        symbol: d.symbol || 'ERC20',
        address: d.token_address,
        balance: balanceBigInt.toString(),
        balanceFormatted: (Number(balanceBigInt) / Math.pow(10, decimals)).toFixed(4),
        decimals,
        logoUrl: d.logo || undefined
      };
    });
  }
}

export function getTokenBalancesProviderFromEnv(): { provider: TokenBalancesProvider; status: string } {
  const mode = (process.env.TOKEN_BALANCES_PROVIDER || 'none').toLowerCase();
  if (mode === 'none') {
    return { provider: new NoneTokenBalancesProvider(), status: 'Token balances provider not configured' };
  }
  if (mode === 'alchemy' || (!process.env.TOKEN_BALANCES_PROVIDER && (process.env.ALCHEMY_API_KEY || process.env.ALCHEMY_BASE_MAINNET_RPC_URL))) {
    if (!process.env.ALCHEMY_API_KEY && !process.env.ALCHEMY_BASE_MAINNET_RPC_URL) {
      return { provider: new NoneTokenBalancesProvider(), status: 'Token balances provider not configured' };
    }
    return { provider: new AlchemyTokenBalancesProvider(process.env.ALCHEMY_API_KEY, process.env.ALCHEMY_BASE_MAINNET_RPC_URL), status: 'Connected' };
  }
  if (mode === 'moralis' || (!process.env.TOKEN_BALANCES_PROVIDER && process.env.MORALIS_API_KEY)) {
    if (!process.env.MORALIS_API_KEY) {
      return { provider: new NoneTokenBalancesProvider(), status: 'Token balances provider not configured' };
    }
    return { provider: new MoralisTokenBalancesProvider(process.env.MORALIS_API_KEY), status: 'Connected' };
  }
  if (mode === 'mock') {
    const { MockTokenBalancesProvider } = require('./mocks.js');
    return { provider: new MockTokenBalancesProvider(), status: 'mock' };
  }
  return { provider: new NoneTokenBalancesProvider(), status: 'Token balances provider not configured' };
}


