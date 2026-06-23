import { MoralisProvider, CoinGeckoProvider, DeFiLlamaProvider, GoPlusProvider } from './interfaces.js';

export class MockMoralisProvider implements MoralisProvider {
  async getWalletTokenBalances(_address: string) {
    return [
      { tokenAddress: '0x123', balance: '1000000000000000000', decimals: 18, symbol: 'MTK' }
    ];
  }
}

export class MockCoinGeckoProvider implements CoinGeckoProvider {
  async getSimplePrice(ids: string[], vsCurrencies: string[]) {
    const result: Record<string, Record<string, number>> = {};
    for (const id of ids) {
      result[id] = {};
      for (const curr of vsCurrencies) {
        result[id][curr] = 100.50;
      }
    }
    return result;
  }
}

export class MockDeFiLlamaProvider implements DeFiLlamaProvider {
  async getProtocolTvl(_protocol: string) {
    return 50000000;
  }
}

export class MockGoPlusProvider implements GoPlusProvider {
  async tokenSecurityCheck(_chainId: number, _tokenAddress: string) {
    return {
      is_open_source: "1",
      is_proxy: "0",
      is_mintable: "0",
      is_honeypot: "0"
    };
  }
}
