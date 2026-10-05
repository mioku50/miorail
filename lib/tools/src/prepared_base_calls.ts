import { McpSendCallsClient } from '@mioagent/mcp';
import { validateAerodromeClaimCallsV1 } from '@mioagent/security/aerodromeClaimGuard';
import type { ToolDef, ToolProvider } from './provider.js';

/** Server-owned calls already validated and simulated by the claim vertical.
 * Discovery grants no authority; the tool accepts no caller-authored calls. */
export interface PreparedBaseClaimCallsV1 {
  actionType: 'aerodrome_claim';
  walletAddress: string;
  calls: readonly { to: string; value: string; data: string }[];
}
export class PreparedBaseClaimToolProviderV1 implements ToolProvider {
  readonly id = 'base-mcp-prepared-claim';
  private readonly calls: { to: string; value: string; data: string }[];
  private submitted = false;
  private wallet: string;
  private tool: ToolDef = { name: 'prepared_aerodrome_claim', description: 'Approve the exact server-prepared Aerodrome claim.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
  constructor(private client: McpSendCallsClient, prepared: PreparedBaseClaimCallsV1) {
    if (prepared.actionType !== 'aerodrome_claim' || !prepared.calls.length || prepared.calls.length > 20) {
      throw new Error('base_mcp_prepared_claim_invalid');
    }
    this.calls = prepared.calls.map(call => ({ ...call }));
    this.wallet = prepared.walletAddress;
    validateAerodromeClaimCallsV1(this.wallet, this.calls);
    if (this.calls.some(call => call.value !== '0')) throw new Error('base_mcp_prepared_claim_value');
  }
  async listTools(): Promise<ToolDef[]> {
    return [this.tool];
  }
  findTool(name: string): ToolDef | undefined { return name === this.tool.name ? this.tool : undefined; }
  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    if (name !== 'prepared_aerodrome_claim' || Object.keys(args).length || this.submitted) {
      return { content: JSON.stringify({ errorCode: 'base_mcp_prepared_claim_refused' }), isError: true };
    }
    this.submitted = true;
    try {
      const result = await this.client.sendAerodromeClaimCalls(this.wallet, this.calls);
      return { content: JSON.stringify(result), isError: false };
    } catch {
      return { content: JSON.stringify({ errorCode: 'base_mcp_claim_outcome_unknown' }), isError: true };
    }
  }
}
