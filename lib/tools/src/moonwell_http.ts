import type { ToolDef, ToolProvider } from './provider.js';
import { partnerFetch, PartnerHostNotAllowlistedError } from '@mioagent/security/httpAllowlist';

// Moonwell has no MCP server: it is a plain HTTP API
// (source: lib/runtime-skills/plugins/moonwell.md, base/skills). Every request
// goes through `partnerFetch` so the host allowlist and request timeout are
// enforced in one place instead of being hardcoded per-provider.
const BASE_URL = 'https://api.moonwell.fi';
const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

const READ_TOOLS = new Map<string, ToolDef>([
  ['moonwell_get_markets', {
    name: 'moonwell_get_markets',
    description: 'Get live Moonwell lending markets on Base. Read-only; never prepares transactions.',
    inputSchema: {
      type: 'object',
      properties: {
        chain: { type: 'string', enum: ['base'] },
        asset: { type: 'string', description: 'Optional asset symbol, for example USDC.' },
      },
      required: ['chain'],
      additionalProperties: false,
    },
  }],
  ['moonwell_get_rates', {
    name: 'moonwell_get_rates',
    description: 'Get live Moonwell supply/borrow rates for an asset on Base. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        chain: { type: 'string', enum: ['base'] },
        asset: { type: 'string' },
      },
      required: ['chain', 'asset'],
      additionalProperties: false,
    },
  }],
  ['moonwell_get_positions', {
    name: 'moonwell_get_positions',
    description: 'Get live Moonwell positions for a wallet on Base. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        chain: { type: 'string', enum: ['base'] },
        address: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
        active: { type: 'boolean' },
      },
      required: ['chain', 'address'],
      additionalProperties: false,
    },
  }],
  ['moonwell_get_health', {
    name: 'moonwell_get_health',
    description: 'Get the Moonwell account health factor for a wallet on Base. Read-only. >1.5 healthy, 1.1-1.5 caution, <1.1 liquidation risk, null means no borrows.',
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
  ['moonwell_get_rewards', {
    name: 'moonwell_get_rewards',
    description: 'Get live Moonwell reward accrual for a wallet on Base. Read-only.',
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
  ['moonwell_get_token_balance', {
    name: 'moonwell_get_token_balance',
    description: 'Get a wallet token balance for a Moonwell-supported asset on Base. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        chain: { type: 'string', enum: ['base'] },
        address: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
        asset: { type: 'string' },
      },
      required: ['chain', 'address', 'asset'],
      additionalProperties: false,
    },
  }],
]);

const PREPARE_VERBS = ['supply', 'withdraw', 'borrow', 'repay'] as const;
type PrepareVerb = typeof PREPARE_VERBS[number];

const PREPARE_TOOLS = new Map<string, ToolDef>(PREPARE_VERBS.map((verb) => [`moonwell_prepare_${verb}`, {
  name: `moonwell_prepare_${verb}`,
  description: `Prepare an unsigned, ordered Moonwell ${verb} transaction batch on Base (chain 8453). Never signs or broadcasts; the caller must execute the returned transactions as a single atomic wallet batch.`,
  inputSchema: {
    type: 'object',
    properties: {
      chain: { type: 'string', enum: ['base'] },
      asset: { type: 'string' },
      amountDecimal: { type: 'string', pattern: '^[0-9]+(?:\\.[0-9]+)?$' },
      from: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
    },
    required: ['chain', 'asset', 'amountDecimal', 'from'],
    additionalProperties: false,
  },
}]));

export interface MoonwellPreparedTransaction {
  step?: string;
  to: string;
  data?: string;
  value?: string;
  chainId?: number;
}

function timeoutMs(): number {
  const parsed = Number(process.env.MOONWELL_HTTP_TIMEOUT_MS || 8_000);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 30_000) : 8_000;
}

function errorCode(error: unknown): string {
  if (error instanceof PartnerHostNotAllowlistedError) return 'moonwell_host_not_allowlisted';
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error || '');
  if (/abort|timeout/i.test(message)) return 'moonwell_timeout';
  if (/401|403|unauthor|forbidden/i.test(message)) return 'moonwell_authorization_failed';
  if (/429|rate|quota/i.test(message)) return 'moonwell_rate_limited';
  if (/404|not.?found/i.test(message)) return 'moonwell_not_found';
  if (/network|fetch|econn|enotfound|unreachable/i.test(message)) return 'moonwell_unreachable';
  return 'moonwell_request_failed';
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitize(item, depth + 1));
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? value.slice(0, 20_000) : value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (/^(access_?token|refresh_?token|id_?token|api_?token|secret|authorization|cookie|password|private_?key|credential|signature)$/i.test(key)) {
      output[key] = '[redacted]';
    } else {
      output[key] = sanitize(inner, depth + 1);
    }
  }
  return output;
}

function normalizedAddress(value: unknown): string | null {
  const address = String(value || '');
  return ADDRESS_PATTERN.test(address) ? address : null;
}

function extractTransactions(payload: unknown): MoonwellPreparedTransaction[] | null {
  const root = payload as Record<string, any> | null;
  const transactions = root?.data?.transactions ?? root?.transactions;
  if (!Array.isArray(transactions) || transactions.length === 0) return null;
  const normalized: MoonwellPreparedTransaction[] = [];
  for (const tx of transactions) {
    if (!tx || typeof tx !== 'object' || typeof tx.to !== 'string' || !ADDRESS_PATTERN.test(tx.to)) return null;
    normalized.push({
      step: typeof tx.step === 'string' ? tx.step : undefined,
      to: tx.to,
      data: typeof tx.data === 'string' ? tx.data : undefined,
      value: typeof tx.value === 'string' ? tx.value : undefined,
      chainId: typeof tx.chainId === 'number' ? tx.chainId : undefined,
    });
  }
  return normalized;
}

type FetchLike = typeof fetch;

/**
 * Moonwell HTTP API tool provider (base/skills official plugin,
 * lib/runtime-skills/plugins/moonwell.md). Reads (markets/rates/positions/
 * health/rewards/token-balance) require no auth; prepare endpoints return
 * unsigned, ordered calldata that only a dedicated server route may execute —
 * the LLM never sees `moonwell_prepare_*` tools because `isWriteTool` filters
 * any tool name containing "prepare" out of the generic chat loop.
 */
export class MoonwellHttpToolProvider implements ToolProvider {
  id = 'moonwell-http';

  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async listTools(): Promise<ToolDef[]> {
    return [...READ_TOOLS.values(), ...PREPARE_TOOLS.values()];
  }

  findTool(name: string): ToolDef | undefined {
    return READ_TOOLS.get(name) || PREPARE_TOOLS.get(name);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    if (args.chain !== 'base') {
      return { content: JSON.stringify({ errorCode: 'moonwell_base_only' }), isError: true };
    }
    try {
      if (READ_TOOLS.has(name)) return await this.callRead(name, args);
      if (PREPARE_TOOLS.has(name)) return await this.callPrepare(name, args);
      return { content: JSON.stringify({ errorCode: 'moonwell_tool_not_allowed' }), isError: true };
    } catch (error) {
      return { content: JSON.stringify({ errorCode: errorCode(error) }), isError: true };
    }
  }

  private async fetchJson(url: string): Promise<unknown> {
    const response = await partnerFetch(url, {}, { timeoutMs: timeoutMs(), fetchImpl: this.fetchImpl });
    if (!response.ok) throw new Error(`moonwell_http_${response.status}`);
    return response.json();
  }

  private async callRead(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    switch (name) {
      case 'moonwell_get_markets': {
        const asset = String(args.asset || '').trim();
        const path = asset ? `/v1/markets/${encodeURIComponent(asset)}` : '/v1/markets';
        const payload = await this.fetchJson(`${BASE_URL}${path}?chain=base`);
        return { content: JSON.stringify(sanitize(payload)), isError: false };
      }
      case 'moonwell_get_rates': {
        const asset = String(args.asset || '').trim();
        if (!asset) return { content: JSON.stringify({ errorCode: 'moonwell_asset_required' }), isError: true };
        const payload = await this.fetchJson(`${BASE_URL}/v1/rates?chain=base&asset=${encodeURIComponent(asset)}`);
        return { content: JSON.stringify(sanitize(payload)), isError: false };
      }
      case 'moonwell_get_positions': {
        const address = normalizedAddress(args.address);
        if (!address) return { content: JSON.stringify({ errorCode: 'moonwell_invalid_wallet_address' }), isError: true };
        const activeParam = args.active === true ? '&active=true' : '';
        const payload = await this.fetchJson(`${BASE_URL}/v1/positions/${address}?chain=base${activeParam}`);
        return { content: JSON.stringify(sanitize(payload)), isError: false };
      }
      case 'moonwell_get_health': {
        const address = normalizedAddress(args.address);
        if (!address) return { content: JSON.stringify({ errorCode: 'moonwell_invalid_wallet_address' }), isError: true };
        const payload = await this.fetchJson(`${BASE_URL}/v1/health/${address}?chain=base`);
        return { content: JSON.stringify(sanitize(payload)), isError: false };
      }
      case 'moonwell_get_rewards': {
        const address = normalizedAddress(args.address);
        if (!address) return { content: JSON.stringify({ errorCode: 'moonwell_invalid_wallet_address' }), isError: true };
        const payload = await this.fetchJson(`${BASE_URL}/v1/rewards/${address}?chain=base`);
        return { content: JSON.stringify(sanitize(payload)), isError: false };
      }
      case 'moonwell_get_token_balance': {
        const address = normalizedAddress(args.address);
        const asset = String(args.asset || '').trim();
        if (!address) return { content: JSON.stringify({ errorCode: 'moonwell_invalid_wallet_address' }), isError: true };
        if (!asset) return { content: JSON.stringify({ errorCode: 'moonwell_asset_required' }), isError: true };
        const payload = await this.fetchJson(`${BASE_URL}/v1/token-balance/${address}?chain=base&asset=${encodeURIComponent(asset)}`);
        return { content: JSON.stringify(sanitize(payload)), isError: false };
      }
      default:
        return { content: JSON.stringify({ errorCode: 'moonwell_tool_not_allowed' }), isError: true };
    }
  }

  private async callPrepare(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    const verb = name.slice('moonwell_prepare_'.length) as PrepareVerb;
    if (!PREPARE_VERBS.includes(verb)) {
      return { content: JSON.stringify({ errorCode: 'moonwell_tool_not_allowed' }), isError: true };
    }
    const asset = String(args.asset || '').trim();
    const amountDecimal = String(args.amountDecimal || '').trim();
    const from = normalizedAddress(args.from);
    if (!asset) return { content: JSON.stringify({ errorCode: 'moonwell_asset_required' }), isError: true };
    if (!/^[0-9]+(?:\.[0-9]+)?$/.test(amountDecimal) || Number(amountDecimal) <= 0) {
      return { content: JSON.stringify({ errorCode: 'moonwell_invalid_amount' }), isError: true };
    }
    if (!from) return { content: JSON.stringify({ errorCode: 'moonwell_invalid_wallet_address' }), isError: true };

    const url = `${BASE_URL}/v1/prepare/${verb}?chain=base&asset=${encodeURIComponent(asset)}&amountDecimal=${encodeURIComponent(amountDecimal)}&from=${from}`;
    const payload = await this.fetchJson(url);
    const transactions = extractTransactions(payload);
    if (!transactions) {
      return { content: JSON.stringify({ errorCode: 'moonwell_prepare_invalid_response' }), isError: true };
    }
    return { content: JSON.stringify({ transactions: sanitize(transactions) }), isError: false };
  }
}
