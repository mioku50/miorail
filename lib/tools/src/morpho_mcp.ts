import type { ToolDef, ToolProvider } from './provider.js';
import { randomUUID } from 'node:crypto';
import { partnerFetch } from '@mioagent/security/httpAllowlist';

const MORPHO_MCP_ENDPOINT = 'https://mcp.morpho.org/';
const READ_TOOLS = new Map<string, ToolDef>([
  ['morpho_query_vaults', {
    name: 'morpho_query_vaults',
    description: 'Query live Morpho vault opportunities on Base. Read-only; never prepares transactions.',
    inputSchema: {
      type: 'object',
      properties: {
        chain: { type: 'string', enum: ['base'] },
        assetSymbol: { type: 'string' },
        assetAddress: { type: 'string' },
        sort: { type: 'string', enum: ['apy_desc', 'apy_asc', 'tvl_desc', 'tvl_asc'] },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['chain'],
      additionalProperties: false,
    },
  }],
  ['morpho_get_vault', {
    name: 'morpho_get_vault',
    description: 'Get one live Morpho vault on Base. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        chain: { type: 'string', enum: ['base'] },
        address: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
      },
      required: ['chain', 'address'],
      additionalProperties: false,
    },
  }],
  ['morpho_query_markets', {
    name: 'morpho_query_markets',
    description: 'Query live Morpho Blue markets on Base. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        chain: { type: 'string', enum: ['base'] },
        loanAsset: { type: 'string' },
        collateralAsset: { type: 'string' },
        sortBy: { type: 'string' },
        sortDirection: { type: 'string', enum: ['asc', 'desc'] },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['chain'],
      additionalProperties: false,
    },
  }],
  ['morpho_get_positions', {
    name: 'morpho_get_positions',
    description: 'Get live Morpho positions for a wallet on Base. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        chain: { type: 'string', enum: ['base'] },
        userAddress: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
      },
      required: ['chain', 'userAddress'],
      additionalProperties: false,
    },
  }],
]);

type FetchLike = typeof fetch;

function timeoutMs(): number {
  const parsed = Number(process.env.MORPHO_MCP_TIMEOUT_MS || 8_000);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 30_000) : 8_000;
}

function safeErrorCode(error: unknown): string {
  const value = error instanceof Error ? `${error.name} ${error.message}` : String(error || '');
  if (/abort|timeout/i.test(value)) return 'morpho_timeout';
  if (/401|403|unauthor|forbidden/i.test(value)) return 'morpho_authorization_failed';
  if (/429|rate|quota/i.test(value)) return 'morpho_rate_limited';
  if (/network|fetch|econn|enotfound|unreachable/i.test(value)) return 'morpho_unreachable';
  return 'morpho_request_failed';
}

function parseSseEnvelope(body: string): unknown {
  const dataLines = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  const raw = dataLines.at(-1) || body.trim();
  const envelope = JSON.parse(raw) as Record<string, any>;
  if (envelope.error) throw new Error('morpho_rpc_error');
  const content = envelope.result?.content;
  if (Array.isArray(content)) {
    const text = content.find((item: any) => item?.type === 'text' && typeof item.text === 'string')?.text;
    if (text) {
      try { return JSON.parse(text); } catch { return text.slice(0, 50_000); }
    }
  }
  return envelope.result ?? envelope;
}

function sanitizePayload(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizePayload(item, depth + 1));
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? value.slice(0, 10_000) : value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (/^(access_?token|refresh_?token|id_?token|api_?token|secret|authorization|cookie|password|private_?key|credential|signature)$/i.test(key)) output[key] = '[redacted]';
    else output[key] = sanitizePayload(inner, depth + 1);
  }
  return output;
}

function validateArgs(name: string, args: Record<string, unknown>): string | null {
  if (args.chain !== 'base') return 'morpho_base_only';
  if (name === 'morpho_get_vault' && !/^0x[a-fA-F0-9]{40}$/.test(String(args.address || ''))) {
    return 'morpho_invalid_vault_address';
  }
  if (name === 'morpho_get_positions' && !/^0x[a-fA-F0-9]{40}$/.test(String(args.userAddress || ''))) {
    return 'morpho_invalid_wallet_address';
  }
  return null;
}

export class MorphoMcpToolProvider implements ToolProvider {
  id = 'morpho-mcp';

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly endpoint = MORPHO_MCP_ENDPOINT,
  ) {}

  async listTools(): Promise<ToolDef[]> {
    return [...READ_TOOLS.values()];
  }

  findTool(name: string): ToolDef | undefined {
    return READ_TOOLS.get(name);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    if (!READ_TOOLS.has(name)) {
      return { content: JSON.stringify({ errorCode: 'morpho_tool_not_allowed' }), isError: true };
    }
    const validationError = validateArgs(name, args);
    if (validationError) return { content: JSON.stringify({ errorCode: validationError }), isError: true };

    try {
      const response = await partnerFetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: randomUUID(),
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      }, { timeoutMs: timeoutMs(), fetchImpl: this.fetchImpl });
      if (!response.ok) throw new Error(`morpho_http_${response.status}`);
      const payload = sanitizePayload(parseSseEnvelope(await response.text()));
      return { content: JSON.stringify(payload), isError: false };
    } catch (error) {
      return { content: JSON.stringify({ errorCode: safeErrorCode(error) }), isError: true };
    }
  }
}
