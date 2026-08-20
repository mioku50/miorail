import * as baseMcpClassifier from '@mioagent/mcp';
import type {
  BaseMcpToolForClassification,
  ClassifiedBaseMcpTool,
} from '@mioagent/mcp';
import type { ToolDef, ToolProvider } from './provider.js';

type ClassifierRuntime = {
  classifyBaseMcpTools?: typeof baseMcpClassifier.classifyBaseMcpTools;
  baseMcpReadOnlyArgumentGuardV1?: typeof baseMcpClassifier.baseMcpReadOnlyArgumentGuardV1;
};

const classifierModule = baseMcpClassifier as unknown as ClassifierRuntime & { default?: ClassifierRuntime };
const classifyBaseMcpToolsRuntime: typeof baseMcpClassifier.classifyBaseMcpTools = (
  classifierModule.classifyBaseMcpTools ||
  classifierModule.default?.classifyBaseMcpTools ||
  (() => {
    throw new Error('Base MCP tool classifier is unavailable');
  })
);

// Resolved from the same module namespace as the classifier above, and treated
// the same way: a build that cannot reach one cannot reach the other, and this
// provider has no safe behaviour without both.
const readOnlyArgumentGuardRuntime: typeof baseMcpClassifier.baseMcpReadOnlyArgumentGuardV1 = (
  classifierModule.baseMcpReadOnlyArgumentGuardV1 ||
  classifierModule.default?.baseMcpReadOnlyArgumentGuardV1 ||
  (() => {
    throw new Error('Base MCP read-only argument guard is unavailable');
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
  const normalized = [...value]
    .map((char) => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127 ? ' ' : char)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
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

/**
 * How deep this walks before giving up.
 *
 * Four of those levels are spent before any real data begins: the MCP
 * envelope is `{content:[{type,text}]}` and `text` is itself a JSON STRING,
 * which costs one more when it is parsed. The old budget of 6 therefore left
 * three levels for the payload — so `get_transaction_history` came back as
 * `{"address":"0x…","transactions":[{"hash":"[truncated]","type":"[truncated]"…`
 * and the model, given a table of placeholders, rendered a table of dots. The
 * user reported it as a bad answer; the tool had answered fine.
 */
const MAX_REDACT_DEPTH_V1 = 12;

function redactSecrets(value: unknown, depth = 0, transactionResult = false, allowSignature = false): unknown {
  // The cap belongs on CONTAINERS only. A string or a number cannot recurse,
  // so cutting one buys no safety and deletes the answer. That ordering is
  // what turned every leaf of a legitimate result into "[truncated]".
  if (Array.isArray(value)) {
    if (depth > MAX_REDACT_DEPTH_V1) return '[truncated]';
    return value.slice(0, 100).map((item) => redactSecrets(item, depth + 1, transactionResult, allowSignature));
  }
  if (typeof value === 'string') {
    const plain = value.replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [redacted]').slice(0, 20_000);
    if (depth > MAX_REDACT_DEPTH_V1) return plain;
    try {
      return JSON.stringify(redactSecrets(JSON.parse(value), depth + 1, transactionResult, allowSignature));
    } catch {
      return plain;
    }
  }
  if (!value || typeof value !== 'object') return value;
  if (depth > MAX_REDACT_DEPTH_V1) return '[truncated]';

  const output: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (/^(access_?token|refresh_?token|id_?token|api_?token|secret|authorization|cookie|password|private_?key|credential)$/i.test(key)
      || (!allowSignature && /^signature$/i.test(key))
      || (transactionResult && (/^(calldata|raw_?transaction|signed_?transaction|permit|permit_?data|signature_?data)$/i.test(key)
        || (/^data$/i.test(key) && typeof inner === 'string' && /^0x[0-9a-f]+$/i.test(inner))))) {
      output[key] = '[redacted]';
    } else {
      output[key] = redactSecrets(inner, depth + 1, transactionResult, allowSignature);
    }
  }
  return output;
}

function serializeToolResult(value: unknown, transactionResult = false, allowSignature = false): string {
  return JSON.stringify(redactSecrets(value, 0, transactionResult, allowSignature));
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
    private readonly options: {
      allowUserConfirmedSwap?: boolean;
      allowUserConfirmedSend?: boolean;
      /** Exact, normalized action tool names released by a vertical adapter. */
      allowedUserConfirmedTools?: readonly string[];
      /** Only a typed SIWE adapter may receive a signature. It must consume it
       * in memory and never copy it to a trace, model context or receipt. */
      sensitiveResultTools?: readonly string[];
    } = {},
  ) {
    this.toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  }

  private walletToolsEnabled = true;

  setWalletToolsEnabled(enabled: boolean): void {
    this.walletToolsEnabled = enabled;
  }

  private visibleTools(): DynamicBaseMcpTool[] {
    return [...this.toolMap.values()].filter((tool) => this.walletToolsEnabled || tool.scope !== 'wallet');
  }

  async listTools(): Promise<ToolDef[]> {
    return this.visibleTools().map(toToolDef);
  }

  findTool(name: string): ToolDef | undefined {
    const tool = this.toolMap.get(name);
    if (tool?.scope === 'wallet' && !this.walletToolsEnabled) return undefined;
    return tool ? toToolDef(tool) : undefined;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    const tool = this.toolMap.get(name);
    if (!tool) return { content: `Unknown tool: ${name}`, isError: true };
    if (tool.scope === 'wallet' && !this.walletToolsEnabled) {
      return {
        content: JSON.stringify({ errorCode: 'base_mcp_wallet_tools_disabled' }),
        isError: true,
      };
    }

    if (tool.capability === 'user_confirmed_transaction') {
      const explicitlyAllowed = (this.options.allowedUserConfirmedTools || [])
        .map(normalizeToolName)
        .includes(normalizeToolName(tool.name));
      const allowedProtectedTool = (this.options.allowUserConfirmedSwap && isSwapTool(tool.name))
        || (this.options.allowUserConfirmedSend && isSendTool(tool.name))
        || explicitlyAllowed;
      if (allowedProtectedTool) {
        try {
          const result = await this.client.getClient().callTool({ name, arguments: args });
          const sensitiveResultAllowed = (this.options.sensitiveResultTools || [])
            .map(normalizeToolName)
            .includes(normalizeToolName(tool.name));
          return { content: serializeToolResult(result, true, sensitiveResultAllowed), isError: false };
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

    // `chain_rpc_request` and `web_request` are read-only per call, not per
    // name. This is where that is decided — after the capability check, so a
    // dispatcher tool cannot smuggle a write past a classification that was
    // only ever able to read the name.
    const verdict = readOnlyArgumentGuardRuntime(tool.name, args);
    if (!verdict.allowed) {
      return {
        isError: true,
        content: JSON.stringify({ errorCode: verdict.errorCode, reason: verdict.reason }),
      };
    }

    try {
      const result = await this.client.getClient().callTool({ name, arguments: args });
      const sensitiveResultAllowed = (this.options.sensitiveResultTools || [])
        .map(normalizeToolName)
        .includes(normalizeToolName(tool.name));
      return { content: serializeToolResult(result, false, sensitiveResultAllowed), isError: false };
    } catch (error) {
      return { content: JSON.stringify({ errorCode: safeCallErrorCode(error) }), isError: true };
    }
  }
}
