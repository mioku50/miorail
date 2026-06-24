import { ToolDef, ToolProvider } from './provider.js';

export class MockMcpToolProvider implements ToolProvider {
  id = 'mock-mcp';

  async listTools(): Promise<ToolDef[]> {
    return [
      {
        name: 'send_calls',
        description: 'Submits multiple contract calls for a single user approval.',
        inputSchema: {
          type: 'object',
          properties: {
            chain: { type: 'string', description: 'The chain to execute on' },
            calls: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  to: { type: 'string' },
                  value: { type: 'string' },
                  data: { type: 'string' }
                },
                required: ['to']
              }
            }
          },
          required: ['chain', 'calls']
        }
      },
      {
        name: 'get_request_status',
        description: 'Poll for the completion status of a request ID.',
        inputSchema: {
          type: 'object',
          properties: {
            requestId: { type: 'string', description: 'The request ID to poll' }
          },
          required: ['requestId']
        }
      }
    ];
  }

  findTool(name: string): ToolDef | undefined {
    const tools: ToolDef[] = [
      {
        name: 'send_calls',
        description: 'Submits multiple contract calls for a single user approval.',
        inputSchema: {
          type: 'object',
          properties: {
            chain: { type: 'string' },
            calls: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  to: { type: 'string' },
                  value: { type: 'string' },
                  data: { type: 'string' }
                },
                required: ['to']
              }
            }
          },
          required: ['chain', 'calls']
        }
      },
      {
        name: 'get_request_status',
        description: 'Poll for the completion status of a request ID.',
        inputSchema: {
          type: 'object',
          properties: { requestId: { type: 'string' } },
          required: ['requestId']
        }
      }
    ];
    return tools.find(t => t.name === name);
  }

  async callTool(name: string, _args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    if (name === 'send_calls') {
      const chain = _args.chain as string;
      const calls = _args.calls as { to: string; value?: string; data?: string }[];

      if (chain !== 'eip155:84532' && chain !== '84532') {
        return { content: 'Unsupported chain. Only Base Sepolia (eip155:84532 or 84532) is supported.', isError: true };
      }

      if (!calls || !Array.isArray(calls) || calls.length === 0) {
        return { content: 'Missing or empty calls array', isError: true };
      }

      const canonicalUSDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
      for (const call of calls) {
        if (!call.to) {
          return { content: 'Missing to address in call', isError: true };
        }
        if (call.data && (call.data.toLowerCase().startsWith('0x095ea7b3') || call.data.toLowerCase().startsWith('0xa9059cbb'))) {
          if (call.to.toLowerCase() !== canonicalUSDC) {
            return { content: 'Invalid token address. Only canonical USDC on Base Sepolia is supported.', isError: true };
          }
        }
      }

      const requestId = 'mock-req-' + Math.random().toString(36).substring(7);
      const approvalUrl = 'https://mock.base.org/approve/' + requestId;
      return { content: JSON.stringify({ approvalUrl, requestId }), isError: false };
    }
    if (name === 'get_request_status') {
      return { content: JSON.stringify({ status: 'confirmed' }), isError: false };
    }
    return { content: `Unknown tool: ${name}`, isError: true };
  }
}
