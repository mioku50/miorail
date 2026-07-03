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
  TokenSecurityResult,
  ApprovalProvider,
  TokenApproval
} from './interfaces.js';

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

export class MockTokenSecurityProvider implements TokenSecurityProvider {
  async getTokenSecurity(params: { chainId: number; tokenAddresses: string[] }): Promise<TokenSecurityResult[]> {
    return params.tokenAddresses
      .filter(address => /^0x[a-fA-F0-9]{40}$/.test(address))
      .slice(0, 50)
      .map(address => ({
        address: address.toLowerCase(),
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

export class MockTokenBalancesProvider implements TokenBalancesProvider {
  async getTokenBalances(_params: { address: string; chainId: number }): Promise<TokenBalance[]> {
    return [
      {
        symbol: 'USDC',
        name: 'USD Coin',
        address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        balance: '15000000',
        balanceFormatted: '15.0000',
        decimals: 6,
        usdValue: '15.00',
        verified: true,
        possibleSpam: false,
      }
    ];
  }
}

export class MockPriceProvider implements PriceProvider {
  async getTokenPrices(params: { chainId: number; tokens: { symbol: string; address?: string }[] }): Promise<TokenPrice[]> {
    return params.tokens.map(t => {
      if (t.symbol === 'ETH' || t.symbol === 'WETH') {
        return { symbol: t.symbol, address: t.address, usdPrice: '3000.00', source: 'coingecko', confidence: 'high' };
      }
      if (t.symbol === 'USDC') {
        return { symbol: t.symbol, address: t.address, usdPrice: '1.00', source: 'coingecko', confidence: 'high' };
      }
      return { symbol: t.symbol, address: t.address, usdPrice: undefined, source: 'none', confidence: 'unknown' };
    });
  }
}

export class MockApprovalProvider implements ApprovalProvider {
  async getTokenApprovals(_params: { walletAddress: string; chainId: number }): Promise<TokenApproval[]> {
    return [
      {
        tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        tokenSymbol: 'USDC',
        tokenName: 'USD Coin',
        spenderAddress: '0x9999999999999999999999999999999999999999',
        spenderLabel: undefined,
        allowanceRaw: '115792089237316195423570985008687907853269984665640564039457584007913129639935',
        allowanceFormatted: 'Unlimited',
        isUnlimited: true,
        source: 'moralis'
      },
      {
        tokenAddress: '0x4200000000000000000000000000000000000006',
        tokenSymbol: 'WETH',
        tokenName: 'Wrapped Ether',
        spenderAddress: '0x2626664c2603336e57b271c5c0b26f421741e481',
        spenderLabel: 'Uniswap V3 Router',
        allowanceRaw: '1000000000000000000',
        allowanceFormatted: '1.0',
        isUnlimited: false,
        source: 'moralis'
      }
    ];
  }
}


