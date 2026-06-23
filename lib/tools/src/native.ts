import { ToolDef, ToolProvider } from './provider.js';
import { DataProvider } from './data-providers.js';

export class NativeToolProvider implements ToolProvider {
  id = 'native';

  constructor(private dataProvider: DataProvider) {}

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
    ];
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
    ].find(t => t.name === name);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    try {
      if (name === 'get_token_price') {
        const token = args.token as string;
        if (!token) return { content: 'Missing token parameter', isError: true };
        const price = await this.dataProvider.getPrice(token);
        return { content: JSON.stringify({ token, priceUsd: price }), isError: false };
      }
      if (name === 'get_wallet_portfolio') {
        const wallet = args.wallet as string;
        if (!wallet) return { content: 'Missing wallet parameter', isError: true };
        const portfolio = await this.dataProvider.getPortfolio(wallet);
        return { content: JSON.stringify(portfolio), isError: false };
      }
      return { content: `Unknown tool: ${name}`, isError: true };
    } catch (error: unknown) {
      return { content: error.message, isError: true };
    }
  }
}
