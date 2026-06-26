import { MoralisProvider, CoinGeckoProvider, DeFiLlamaProvider, GoPlusProvider } from './interfaces.js';

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
