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

  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    if (name === 'send_calls') {
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
