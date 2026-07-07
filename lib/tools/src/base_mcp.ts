import { McpSendCallsClient } from '@mioagent/mcp';
import { validateBaseCalls } from '@mioagent/security/baseGuards';
import { ToolDef, ToolProvider } from './provider.js';

export class BaseMcpToolProvider implements ToolProvider {
  id = 'base-mcp';

  constructor(private mcpClient?: McpSendCallsClient) {}

  private tools: ToolDef[] = [
    {
      name: 'send_calls',
      description: 'Submits Base Mainnet contract calls for a single user approval through Base MCP.',
      inputSchema: {
        type: 'object',
        properties: {
          chain: { type: 'string', description: 'Base chain, e.g. eip155:8453 or 8453' },
          calls: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                to: { type: 'string' },
                value: { type: 'string' },
                data: { type: 'string' },
              },
              required: ['to'],
            },
          },
        },
        required: ['chain', 'calls'],
      },
    },
    {
      name: 'sepolia_send_calls',
      description: 'Submits Base Sepolia contract calls for a single user approval through Base MCP.',
      inputSchema: {
        type: 'object',
        properties: {
          chain: { type: 'string', description: 'Base Sepolia chain, e.g. eip155:84532 or 84532' },
          calls: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                to: { type: 'string' },
                value: { type: 'string' },
                data: { type: 'string' },
              },
              required: ['to'],
            },
          },
        },
        required: ['chain', 'calls'],
      },
    },
  ];

  async listTools(): Promise<ToolDef[]> {
    return this.tools;
  }

  findTool(name: string): ToolDef | undefined {
    return this.tools.find((tool) => tool.name === name);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    if (name !== 'send_calls' && name !== 'sepolia_send_calls') {
      return { content: `Unknown tool: ${name}`, isError: true };
    }

    const chain = args.chain as string;
    const calls = args.calls as { to: string; value?: string; data?: string }[];
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

    if (!this.mcpClient) {
      return { content: 'Base MCP is not configured/connected. Real execution is unavailable.', isError: true };
    }

    try {
      const response = await this.mcpClient.sendCalls(chain, calls);
      return {
        content: JSON.stringify({ approvalUrl: response.approvalUrl, requestId: response.requestId }),
        isError: false,
      };
    } catch (error) {
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  }
}
