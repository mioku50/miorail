import { ToolDef, ToolProvider } from './provider.js';
import { validateBaseCalls } from '@mioagent/security/baseGuards';

export class MockMcpToolProvider implements ToolProvider {
  id = 'mock-mcp';

  async listTools(): Promise<ToolDef[]> {
    return [
      {
        name: 'send_calls',
        description: 'Submits Base Mainnet contract calls for a single user approval.',
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
        name: 'sepolia_send_calls',
        description: 'Submits Base Sepolia contract calls for a single user approval.',
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
        description: 'Submits Base Mainnet contract calls for a single user approval.',
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
        name: 'sepolia_send_calls',
        description: 'Submits Base Sepolia contract calls for a single user approval.',
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
    if (name === 'send_calls' || name === 'sepolia_send_calls') {
      const chain = _args.chain as string;
      const calls = _args.calls as { to: string; value?: string; data?: string }[];

      try {
        const normalized = validateBaseCalls(chain, calls);
        if (name === 'send_calls' && normalized.chainId !== 8453) {
          return { content: 'Unsupported chain. send_calls only supports Base Mainnet (8453).', isError: true };
        }
        if (name === 'sepolia_send_calls' && normalized.chainId !== 84532) {
          return { content: 'Unsupported chain. sepolia_send_calls only supports Base Sepolia (84532).', isError: true };
        }
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true };
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
