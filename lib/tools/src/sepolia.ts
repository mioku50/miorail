import { ToolDef, ToolProvider } from './provider.js';

export class SepoliaToolProvider implements ToolProvider {
  id = 'sepolia-read-only';
  private rpcUrl = 'https://sepolia.base.org';

  async listTools(): Promise<ToolDef[]> {
    return [
      {
        name: 'sepolia_get_balance',
        description: 'Get the native ETH balance of an address on Base Sepolia',
        inputSchema: {
          type: 'object',
          properties: {
            address: { type: 'string', description: 'The wallet address' }
          },
          required: ['address']
        }
      },
      {
        name: 'sepolia_get_transaction',
        description: 'Get transaction details by hash on Base Sepolia',
        inputSchema: {
          type: 'object',
          properties: {
            hash: { type: 'string', description: 'The transaction hash' }
          },
          required: ['hash']
        }
      }
    ];
  }

  findTool(name: string): ToolDef | undefined {
    return [
      {
        name: 'sepolia_get_balance',
        description: 'Get the native ETH balance of an address on Base Sepolia',
        inputSchema: {
          type: 'object',
          properties: {
            address: { type: 'string' }
          },
          required: ['address']
        }
      },
      {
        name: 'sepolia_get_transaction',
        description: 'Get transaction details by hash on Base Sepolia',
        inputSchema: {
          type: 'object',
          properties: {
            hash: { type: 'string' }
          },
          required: ['hash']
        }
      }
    ].find(t => t.name === name);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    try {
      if (name === 'sepolia_get_balance') {
        const address = args.address as string;
        if (!address) return { content: 'Missing address parameter', isError: true };

        const res = await fetch(this.rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_getBalance',
            params: [address, 'latest']
          })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error.message);
        return { content: JSON.stringify({ address, balanceWei: data.result }), isError: false };
      }

      if (name === 'sepolia_get_transaction') {
        const hash = args.hash as string;
        if (!hash) return { content: 'Missing hash parameter', isError: true };

        const res = await fetch(this.rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_getTransactionByHash',
            params: [hash]
          })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error.message);
        return { content: JSON.stringify({ hash, transaction: data.result }), isError: false };
      }

      return { content: `Unknown tool: ${name}`, isError: true };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { content: errorMessage, isError: true };
    }
  }
}
