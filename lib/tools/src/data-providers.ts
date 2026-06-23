export interface DataProvider {
  getPrice(token: string): Promise<number>;
  getPortfolio(_wallet: string): Promise<Record<string, unknown>>;
}

export class MockDataProvider implements DataProvider {
  async getPrice(token: string): Promise<number> {
    if (token.toLowerCase() === 'eth') return 3500.00;
    return 100.50;
  }
  async getPortfolio(_wallet: string): Promise<Record<string, unknown>> {
    return {
      wallet: _wallet,
      totalValueUsd: 15000,
      tokens: [
        { symbol: 'ETH', balance: 2.0, valueUsd: 7000 },
        { symbol: 'USDC', balance: 8000, valueUsd: 8000 }
      ]
    };
  }
}

export interface MoralisProvider {
  getWalletTokenBalances(_wallet: string): Promise<{ token: string; balance: string }[]>;
}

export class MockMoralisProvider implements MoralisProvider {
  async getWalletTokenBalances(_wallet: string): Promise<{ token: string; balance: string }[]> {
    return [
      { token: 'ETH', balance: '2.5' },
      { token: 'USDC', balance: '1000' }
    ];
  }
}

export interface CoinGeckoProvider {
  getSimplePrice(id: string): Promise<{ [id: string]: { usd: number } }>;
}

export class MockCoinGeckoProvider implements CoinGeckoProvider {
  async getSimplePrice(id: string): Promise<{ [id: string]: { usd: number } }> {
    if (id === 'ethereum') return { ethereum: { usd: 3500 } };
    if (id === 'usd-coin') return { 'usd-coin': { usd: 1 } };
    return { [id]: { usd: 100 } };
  }
}

export interface DeFiLlamaProvider {
  getProtocolTvl(protocol: string): Promise<{ tvl: number }>;
}

export class MockDeFiLlamaProvider implements DeFiLlamaProvider {
  async getProtocolTvl(protocol: string): Promise<{ tvl: number }> {
    if (protocol === 'uniswap-v3') return { tvl: 5000000000 };
    return { tvl: 1000000 };
  }
}

export interface GoPlusProvider {
  getTokenSecurity(_address: string, _chainId: string): Promise<Record<string, unknown>>;
}

export class MockGoPlusProvider implements GoPlusProvider {
  async getTokenSecurity(_address: string, _chainId: string): Promise<Record<string, unknown>> {
    return {
      is_honeypot: "0",
      is_blacklisted: "0",
      is_open_source: "1"
    };
  }
}
