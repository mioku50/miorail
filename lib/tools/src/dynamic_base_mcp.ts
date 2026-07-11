import * as baseMcpClassifier from '@mioagent/mcp';
import type {
  BaseMcpToolForClassification,
  ClassifiedBaseMcpTool,
} from '@mioagent/mcp';
import type { ToolDef, ToolProvider } from './provider.js';

type ClassifierRuntime = {
  classifyBaseMcpTools?: typeof baseMcpClassifier.classifyBaseMcpTools;
};

const classifierModule = baseMcpClassifier as unknown as ClassifierRuntime & { default?: ClassifierRuntime };
const classifyBaseMcpToolsRuntime: typeof baseMcpClassifier.classifyBaseMcpTools = (
  classifierModule.classifyBaseMcpTools ||
  classifierModule.default?.classifyBaseMcpTools ||
  (() => {
    throw new Error('Base MCP tool classifier is unavailable');
  })
);

type BaseMcpCallClient = {
  getClient(): {
    callTool(input: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
    listTools?(params?: { cursor?: string }): Promise<{ tools?: unknown[]; nextCursor?: string }>;
  };
};

export interface DynamicBaseMcpTool extends ClassifiedBaseMcpTool {
  inputSchema: Record<string, unknown>;
  group: string;
}

const EXACT_SEND_CALLS = new Set(['sendcalls', 'sepoliasendcalls', 'walletsendcalls']);

function sanitizeText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.slice(0, maxLength);
}

function sanitizeSchema(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { type: 'object', additionalProperties: true };
  }
  return value as Record<string, unknown>;
}

function sanitizeTool(raw: unknown): (BaseMcpToolForClassification & { inputSchema: Record<string, unknown> }) | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const name = sanitizeText(obj.name, 120);
  if (!name) return null;
  const description = sanitizeText(obj.description, 500);
  return {
    name,
    ...(description ? { description } : {}),
    inputSchema: sanitizeSchema(obj.inputSchema),
  };
}

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSwapTool(name: string): boolean {
  const normalized = normalizeToolName(name);
  return normalized === 'swap' || normalized === 'swaptokens' || normalized === 'tokenswap';
}

function isSendTool(name: string): boolean {
  const normalized = normalizeToolName(name);
  return normalized === 'send' || normalized === 'transfer' || normalized === 'sendtoken' || normalized === 'transfertoken';
}

export function inferBaseMcpToolGroup(name: string): string {
  const normalized = normalizeToolName(name);
  if (isSendTool(name)) return 'base';
  if (normalized.includes('balance') || normalized.includes('wallet') || normalized.includes('account')) return 'wallet';
  if (normalized.includes('price') || normalized.includes('quote') || normalized.includes('swap')) return 'swap';
  if (normalized.includes('history') || normalized.includes('transaction')) return 'history';
  if (normalized.includes('token')) return 'token';
  if (normalized.includes('x402') || normalized.includes('pay')) return 'x402';
  const prefix = name.toLowerCase().split(/[_:.\-/]/).find(Boolean);
  return prefix?.replace(/[^a-z0-9]/g, '') || 'base';
}

function baseMcpGroupEnabled(toggles: Record<string, boolean> | undefined, group: string): boolean {
  if (!toggles) return true;
  if (toggles.base_mcp === false || toggles['base-mcp'] === false) return false;
  const groupKeys = [
    `base_mcp:${group}`,
    `base-mcp:${group}`,
    `base_mcp_${group}`,
    `base-mcp-${group}`,
  ];
  return !groupKeys.some((key) => toggles[key] === false);
}

function shouldRegisterTool(tool: DynamicBaseMcpTool): boolean {
  if (EXACT_SEND_CALLS.has(normalizeToolName(tool.name))) return false;
  if (tool.capability === 'read_only') return tool.enabled;
  return tool.capability === 'user_confirmed_transaction';
}

function toToolDef(tool: DynamicBaseMcpTool): ToolDef {
  return {
    name: tool.name,
    description:
      tool.capability === 'user_confirmed_transaction'
        ? `${tool.description || tool.name} (requires user-confirmed action preparation; not directly executable)`
        : tool.description || tool.name,
    inputSchema: tool.inputSchema,
  };
}

function redactSecrets(value: unknown, depth = 0, transactionResult = false): unknown {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactSecrets(item, depth + 1, transactionResult));
  if (typeof value === 'string') {
    try {
      return JSON.stringify(redactSecrets(JSON.parse(value), depth + 1, transactionResult));
    } catch {
      return value.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [redacted]').slice(0, 20_000);
    }
  }
  if (!value || typeof value !== 'object') return value;

  const output: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (/^(access_?token|refresh_?token|id_?token|api_?token|secret|authorization|cookie|password|private_?key|credential|signature)$/i.test(key)
      || (transactionResult && (/^(calldata|raw_?transaction|signed_?transaction|permit|permit_?data|signature_?data)$/i.test(key)
        || (/^data$/i.test(key) && typeof inner === 'string' && /^0x[0-9a-f]+$/i.test(inner))))) {
      output[key] = '[redacted]';
    } else {
      output[key] = redactSecrets(inner, depth + 1, transactionResult);
    }
  }
  return output;
}

function serializeToolResult(value: unknown, transactionResult = false): string {
  return JSON.stringify(redactSecrets(value, 0, transactionResult));
}

function safeCallErrorCode(error: unknown): string {
  const value = error instanceof Error ? `${error.name} ${error.message}` : String(error || '');
  if (/401|403|unauthor|forbidden|invalid_grant|invalid token/i.test(value)) return 'base_mcp_reauth_required';
  if (/abort|timeout/i.test(value)) return 'base_mcp_timeout';
  if (/network|fetch|econn|enotfound|unreachable/i.test(value)) return 'base_mcp_unreachable';
  return 'base_mcp_tool_failed';
}

export function classifyDynamicBaseMcpTools(
  rawTools: unknown[],
  toggles?: Record<string, boolean>,
): DynamicBaseMcpTool[] {
  const sanitized = rawTools.map(sanitizeTool).filter((tool): tool is NonNullable<ReturnType<typeof sanitizeTool>> => !!tool);
  const inputSchemas = new Map(sanitized.map((tool) => [tool.name, tool.inputSchema]));
  return classifyBaseMcpToolsRuntime(sanitized)
    .tools
    .map((tool) => ({
      ...tool,
      inputSchema: inputSchemas.get(tool.name) || { type: 'object', additionalProperties: true },
      group: inferBaseMcpToolGroup(tool.name),
    }))
    .filter((tool) => baseMcpGroupEnabled(toggles, tool.group))
    .filter(shouldRegisterTool);
}

export async function listDynamicBaseMcpToolsFromClient(
  client: BaseMcpCallClient,
  toggles?: Record<string, boolean>,
): Promise<DynamicBaseMcpTool[]> {
  const listTools = client.getClient().listTools;
  if (!listTools) return [];

  const rawTools: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const response = await listTools.call(client.getClient(), cursor ? { cursor } : undefined);
    if (Array.isArray(response.tools)) rawTools.push(...response.tools);
    cursor = typeof response.nextCursor === 'string' && response.nextCursor ? response.nextCursor : undefined;
    if (!cursor) break;
  }
  return classifyDynamicBaseMcpTools(rawTools, toggles);
}

export class DynamicBaseMcpToolProvider implements ToolProvider {
  id = 'base-mcp-dynamic';
  private toolMap: Map<string, DynamicBaseMcpTool>;

  constructor(
    private client: BaseMcpCallClient,
    tools: DynamicBaseMcpTool[],
    private readonly options: { allowUserConfirmedSwap?: boolean; allowUserConfirmedSend?: boolean } = {},
  ) {
    this.toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  }

  async listTools(): Promise<ToolDef[]> {
    return [...this.toolMap.values()].map(toToolDef);
  }

  findTool(name: string): ToolDef | undefined {
    const tool = this.toolMap.get(name);
    return tool ? toToolDef(tool) : undefined;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    const tool = this.toolMap.get(name);
    if (!tool) return { content: `Unknown tool: ${name}`, isError: true };

    if (tool.capability === 'user_confirmed_transaction') {
      const allowedProtectedTool = (this.options.allowUserConfirmedSwap && isSwapTool(tool.name))
        || (this.options.allowUserConfirmedSend && isSendTool(tool.name));
      if (allowedProtectedTool) {
        try {
          const result = await this.client.getClient().callTool({ name, arguments: args });
          return { content: serializeToolResult(result, true), isError: false };
        } catch (error) {
          return { content: JSON.stringify({ errorCode: safeCallErrorCode(error) }), isError: true };
        }
      }
      return {
        isError: true,
        content: JSON.stringify({
          status: 'approval_required',
          tool: name,
          reason:
            'Base MCP transaction tools are not directly executable. Prepare an action and pass screenAction, simulateTrade, and validateBaseCalls before wallet confirmation.',
        }),
      };
    }

    if (tool.capability !== 'read_only') {
      return { content: `Base MCP tool disabled: ${tool.reason}`, isError: true };
    }

    try {
      const result = await this.client.getClient().callTool({ name, arguments: args });
      return { content: serializeToolResult(result), isError: false };
    } catch (error) {
      return { content: JSON.stringify({ errorCode: safeCallErrorCode(error) }), isError: true };
    }
  }
}
