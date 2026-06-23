export interface DataProvider {
  getPrice(token: string): Promise<number>;
  getPortfolio(wallet: string): Promise<any>;
}

export class MockDataProvider implements DataProvider {
  async getPrice(token: string): Promise<number> {
    if (token.toLowerCase() === 'eth') return 3500.00;
    return 100.50;
  }
  async getPortfolio(wallet: string): Promise<any> {
    return {
      wallet,
      totalValueUsd: 15000,
      tokens: [
        { symbol: 'ETH', balance: 2.0, valueUsd: 7000 },
        { symbol: 'USDC', balance: 8000, valueUsd: 8000 }
      ]
    };
  }
}
