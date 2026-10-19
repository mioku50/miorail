import { McpSendCallsClient } from '@mioagent/mcp';
import { validateAerodromeClaimCallsV1 } from '@mioagent/security/aerodromeClaimGuard';
import { validateUniswapCollectCallsV1 } from '@mioagent/security/uniswapCollectGuard';
import { validateNativeSendCallsV1 } from '@mioagent/security/nativeSendGuard';
import type { ToolDef, ToolProvider } from './provider.js';

/** Server-owned calls already validated by a typed vertical: Aerodrome's
 * claim or Uniswap's collect (simulated too), or one ETH send. Discovery
 * grants no authority; the tool accepts no caller-authored calls. */
export interface PreparedBaseClaimCallsV1 {
  actionType: 'aerodrome_claim' | 'uniswap_collect' | 'native_send';
  walletAddress: string;
  calls: readonly { to: string; value: string; data: string }[];
}

const PREPARED_V1 = {
  aerodrome_claim: {
    tool: 'prepared_aerodrome_claim', description: 'Approve the exact server-prepared Aerodrome claim.',
    validate: validateAerodromeClaimCallsV1,
    send: (client: McpSendCallsClient, wallet: string, calls: { to: string; value: string; data: string }[]) =>
      client.sendAerodromeClaimCalls(wallet, calls),
  },
  uniswap_collect: {
    tool: 'prepared_uniswap_collect', description: 'Approve the exact server-prepared Uniswap fee collect.',
    validate: validateUniswapCollectCallsV1,
    send: (client: McpSendCallsClient, wallet: string, calls: { to: string; value: string; data: string }[]) =>
      client.sendUniswapCollectCalls(wallet, calls),
  },
  native_send: {
    tool: 'prepared_native_send', description: 'Approve the exact server-prepared ETH send.',
    validate: validateNativeSendCallsV1,
    send: (client: McpSendCallsClient, wallet: string, calls: { to: string; value: string; data: string }[]) =>
      client.sendNativeTransferCalls(wallet, calls),
  },
} as const;

export class PreparedBaseClaimToolProviderV1 implements ToolProvider {
  readonly id = 'base-mcp-prepared-claim';
  private readonly calls: { to: string; value: string; data: string }[];
  private readonly kind: (typeof PREPARED_V1)[keyof typeof PREPARED_V1];
  private submitted = false;
  private wallet: string;
  private tool: ToolDef;
  constructor(private client: McpSendCallsClient, prepared: PreparedBaseClaimCallsV1) {
    if (!Object.hasOwn(PREPARED_V1, prepared.actionType) || !prepared.calls.length || prepared.calls.length > 20) {
      throw new Error('base_mcp_prepared_claim_invalid');
    }
    this.kind = PREPARED_V1[prepared.actionType];
    this.tool = { name: this.kind.tool, description: this.kind.description,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
    this.calls = prepared.calls.map(call => ({ ...call }));
    this.wallet = prepared.walletAddress;
    this.kind.validate(this.wallet, this.calls);
    // Only a send moves ETH, and its guard has just bounded it to one call.
    if (prepared.actionType !== 'native_send' && this.calls.some(call => call.value !== '0')) {
      throw new Error('base_mcp_prepared_claim_value');
    }
  }
  async listTools(): Promise<ToolDef[]> {
    return [this.tool];
  }
  findTool(name: string): ToolDef | undefined { return name === this.tool.name ? this.tool : undefined; }
  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    if (name !== this.tool.name || Object.keys(args).length || this.submitted) {
      return { content: JSON.stringify({ errorCode: 'base_mcp_prepared_claim_refused' }), isError: true };
    }
    this.submitted = true;
    try {
      const result = await this.kind.send(this.client, this.wallet, this.calls);
      return { content: JSON.stringify(result), isError: false };
    } catch {
      return { content: JSON.stringify({ errorCode: 'base_mcp_claim_outcome_unknown' }), isError: true };
    }
  }
}
