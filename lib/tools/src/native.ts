import { ToolDef, ToolProvider } from './provider.js';
import { CoinGeckoProvider, MoralisProvider } from '@mioagent/data-providers';

export class NativeToolProvider implements ToolProvider {
  id = 'native';

  constructor(
    private coinGecko?: CoinGeckoProvider,
    private moralis?: MoralisProvider
  ) {}

  async listTools(): Promise<ToolDef[]> {
    return [
      {
        name: 'get_token_price',
        description: 'Get the current price of a token in USD',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'The token symbol (e.g., ETH, USDC)' }
          },
          required: ['token']
        }
      },
      {
        name: 'get_wallet_portfolio',
        description: 'Get the total portfolio value and token balances for a wallet',
        inputSchema: {
          type: 'object',
          properties: {
            wallet: { type: 'string', description: 'The wallet address' }
          },
          required: ['wallet']
        }
      }
    ].filter((tool) => tool.name === 'get_token_price' ? !!this.coinGecko : !!this.moralis);
  }

  findTool(name: string): ToolDef | undefined {
    return [
      {
        name: 'get_token_price',
        description: 'Get the current price of a token in USD',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'The token symbol (e.g., ETH, USDC)' }
          },
          required: ['token']
        }
      },
      {
        name: 'get_wallet_portfolio',
        description: 'Get the total portfolio value and token balances for a wallet',
        inputSchema: {
          type: 'object',
          properties: {
            wallet: { type: 'string', description: 'The wallet address' }
          },
          required: ['wallet']
        }
      }
    ].filter((tool) => tool.name === 'get_token_price' ? !!this.coinGecko : !!this.moralis).find(t => t.name === name);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    try {
      if (name === 'get_token_price') {
        if (!this.coinGecko) return { content: 'Price provider unavailable', isError: true };
        const token = args.token as string;
        if (!token) return { content: 'Missing token parameter', isError: true };
        const prices = await this.coinGecko.getSimplePrice([token.toLowerCase()], ['usd']);
        const price = prices[token.toLowerCase()]?.usd || 0;
        return { content: JSON.stringify({ token, priceUsd: price }), isError: false };
      }
      if (name === 'get_wallet_portfolio') {
        if (!this.moralis) return { content: 'Portfolio provider unavailable', isError: true };
        const wallet = args.wallet as string;
        if (!wallet) return { content: 'Missing wallet parameter', isError: true };
        const balances = await this.moralis.getWalletTokenBalances(wallet);
        return { content: JSON.stringify({ wallet, tokens: balances }), isError: false };
      }
      return { content: `Unknown tool: ${name}`, isError: true };
    } catch (error: unknown) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  return { content: errorMessage, isError: true };
}
  }
}
