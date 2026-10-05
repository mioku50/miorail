import type { BaseMcpCallsV1 } from "./pool.js";
import { validateBaseCalls } from "@mioagent/security/baseGuards";
import { validateAerodromeClaimCallsV1 } from '@mioagent/security/aerodromeClaimGuard';

export interface SendCallsResponse {
  approvalUrl: string;
  requestId: string;
}

export class McpSendCallsClient {
  /** A `BaseMcpClient` or a pooled lease: only `callTool` is used. */
  constructor(private client: { getClient(): Pick<BaseMcpCallsV1, "callTool"> }) {}

  /** Closed claim-only transport; the generic sendCalls guard stays intact. */
  async sendAerodromeClaimCalls(wallet: string, calls: { to: string; value: string; data: string }[]): Promise<SendCallsResponse> {
    validateAerodromeClaimCallsV1(wallet, calls);
    const result = await this.client.getClient().callTool({ name: 'send_calls', arguments: { chain: 'base', calls } });
    return this.approvalResponse(result);
  }

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

    return this.approvalResponse(result);
  }

  private approvalResponse(result: any): SendCallsResponse {
    if (result?.isError) throw new Error('MCP approval request failed');
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
