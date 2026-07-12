import { BaseMcpClient } from "./client.js";
import { validateBaseCalls } from "@mioagent/security/baseGuards";

export interface SendCallsResponse {
  approvalUrl: string;
  requestId: string;
}

export class McpSendCallsClient {
  constructor(private client: BaseMcpClient) {}

  async sendCalls(chain: string, calls: { to: string; value?: string; data?: string }[]): Promise<SendCallsResponse> {
    let normalized;
    try {
      normalized = validateBaseCalls(chain, calls);
    } catch (error) {
      throw new Error(`Security check failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }

    const result = await this.client.getClient().callTool({
      name: normalized.sendCallsTool,
      arguments: { chain: normalized.mcpChain, calls }
    });

    let approvalUrl: string | undefined;
    let requestId: string | undefined;

    if (result && result.content && Array.isArray(result.content)) {
      for (const item of result.content) {
        if (item.type === 'text') {
          try {
            const parsed = JSON.parse(item.text);
            if (parsed.approvalUrl) approvalUrl = parsed.approvalUrl;
            if (parsed.requestId) requestId = parsed.requestId;
          } catch {
            // ignore parse errors
          }
        }
      }
    }

    if (!approvalUrl || !requestId) {
      throw new Error("Invalid response from MCP send_calls tool");
    }

    return { approvalUrl, requestId };
  }
}
