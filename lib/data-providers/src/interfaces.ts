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
