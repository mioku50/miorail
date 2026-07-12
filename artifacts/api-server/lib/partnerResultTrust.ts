import { getBaseMainnetUsdcAddress } from '@mioagent/security';
import { filterTrustedMorphoMarkets, filterTrustedMorphoVaults } from './morphoVaultTrust.js';
import { getRuntimeSkill } from '@mioagent/runtime-skills';

export interface PartnerToolResultScreenInput {
  toolName: string;
  content: string;
  isError: boolean;
  providerNamespace?: string;
}

export interface PartnerToolResultScreened {
  content: string;
  isError: boolean;
}

const PARTNER_VERBS = new Set([
  'get', 'list', 'query', 'read', 'search', 'check', 'fetch', 'lookup', 'view', 'find',
  'quote', 'prepare', 'swap', 'send', 'sign', 'deposit', 'withdraw', 'supply', 'borrow', 'repay',
]);
const SECRET_KEYS = /^(access_?token|refresh_?token|id_?token|api_?token|secret|authorization|cookie|password|private_?key|credential|signature)$/i;
const BLOCKED_TEXT = /\b(test|testing|demo|mock|fake|spam|scam|honeypot|deprecated)\b/i;

function providerFromToolName(toolName: string): string | undefined {
  const parts = toolName.toLowerCase().split(/[_:.\-/]/).filter(Boolean);
  return parts.length >= 2 && !PARTNER_VERBS.has(parts[0]!) && PARTNER_VERBS.has(parts[1]!)
    ? parts[0]
    : undefined;
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, depth + 1));
  if (!value || typeof value !== 'object') {
    return typeof value === 'string'
      ? [...value].map((char) => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127 ? ' ' : char).join('').slice(0, 10_000)
      : value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SECRET_KEYS.test(key) ? '[redacted]' : sanitize(inner, depth + 1);
  }
  return output;
}

function unwrap(content: string): unknown {
  let value: unknown = content;
  for (let pass = 0; pass < 4; pass += 1) {
    if (typeof value === 'string') {
      const stringValue = value;
      try { value = JSON.parse(stringValue); } catch { return stringValue.slice(0, 20_000); }
      continue;
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, any>;
      if (Array.isArray(record.content)) {
        const text = record.content.find((item: any) => item?.type === 'text' && typeof item.text === 'string')?.text;
        if (text) { value = text; continue; }
      }
    }
    break;
  }
  return sanitize(value);
}

function error(errorCode: string): PartnerToolResultScreened {
  return { content: JSON.stringify({ errorCode }), isError: true };
}

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
}

function numeric(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function containsUnsafeFinancialData(value: unknown, maxApyPct: number, depth = 0): boolean {
  if (depth > 8) return true;
  if (Array.isArray(value)) return value.some((item) => containsUnsafeFinancialData(item, maxApyPct, depth + 1));
  if (!value || typeof value !== 'object') return typeof value === 'string' && BLOCKED_TEXT.test(value);
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (/apy/i.test(key)) {
      const apy = numeric(inner);
      if (apy !== null && (apy < 0 || apy > maxApyPct)) return true;
    }
    if (/^(verified|isVerified)$/i.test(key) && inner === false) return true;
    if (containsUnsafeFinancialData(inner, maxApyPct, depth + 1)) return true;
  }
  return false;
}

function screenMorpho(toolName: string, content: string): PartnerToolResultScreened {
  const payload = unwrap(content);
  if (toolName === 'morpho_query_vaults' || toolName === 'morpho_get_vault') {
    const root = asRecord(payload);
    const wrapped = toolName === 'morpho_get_vault'
      ? { chain: root?.chain, vaults: [root?.vault ?? root?.data ?? root] }
      : payload;
    const vaults = filterTrustedMorphoVaults(wrapped);
    if (vaults.length === 0) return error('morpho_no_trustworthy_vaults');
    return {
      content: JSON.stringify({
        provider: 'morpho',
        screening: { status: 'screened', ranking: 'verification_then_tvl', recommendation: false },
        vaults,
      }),
      isError: false,
    };
  }

  if (toolName === 'morpho_query_markets' || toolName === 'morpho_get_market') {
    const root = asRecord(payload);
    const wrapped = toolName === 'morpho_get_market'
      ? { chain: root?.chain, markets: [root?.market ?? root?.data ?? root] }
      : payload;
    const markets = filterTrustedMorphoMarkets(wrapped);
    if (markets.length === 0) return error('morpho_no_trustworthy_markets');
    return {
      content: JSON.stringify({
        provider: 'morpho',
        screening: { status: 'screened', ranking: 'liquidity', recommendation: false },
        markets,
      }),
      isError: false,
    };
  }

  const maxApyPct = Number(process.env.MORPHO_MAX_APY_PCT || 100);
  if (containsUnsafeFinancialData(payload, Number.isFinite(maxApyPct) ? maxApyPct : 100)) {
    return error('morpho_result_failed_screening');
  }
  return {
    content: JSON.stringify({
      provider: 'morpho',
      screening: { status: 'screened', recommendation: false },
      data: payload,
    }),
    isError: false,
  };
}

function moonwellRecordIsTrusted(record: Record<string, any>): boolean {
  if (record.deprecated === true || record.verified === false || record.isVerified === false) return false;
  if (containsUnsafeFinancialData(record, Number(process.env.PARTNER_RESULT_MAX_APY_PCT || 100))) return false;

  const canonicalUsdc = getBaseMainnetUsdcAddress().toLowerCase();
  const symbol = String(record.asset?.symbol || record.assetSymbol || record.symbol || '').toUpperCase();
  const underlying = String(
    record.asset?.address || record.assetAddress || record.underlyingAddress || record.tokenAddress || '',
  ).toLowerCase();
  if (symbol === 'USDC' && underlying && underlying !== canonicalUsdc) return false;

  const liquidity = numeric(record.liquidityUsd ?? record.liquidityAssetsUsd ?? record.tvlUsd ?? record.totalSupplyUsd);
  const minLiquidity = Number(process.env.PARTNER_RESULT_MIN_LIQUIDITY_USD || 100_000);
  if (liquidity !== null && liquidity < (Number.isFinite(minLiquidity) ? minLiquidity : 100_000)) return false;
  return true;
}

function screenMoonwell(content: string): PartnerToolResultScreened {
  const payload = unwrap(content);
  const root = asRecord(payload);
  if (!root) return error('moonwell_result_invalid');
  const chain = String(root.chain ?? root.data?.chain ?? 'base').toLowerCase();
  if (!['base', '8453', 'eip155:8453'].includes(chain)) return error('moonwell_wrong_chain');

  const collectionKey = ['markets', 'rates', 'opportunities', 'yield'].find((key) => Array.isArray(root[key]));
  const dataArray = Array.isArray(root.data) ? root.data : undefined;
  const records = collectionKey ? root[collectionKey!] : dataArray;
  if (records) {
    const trusted = records.filter((item: unknown) => {
      const record = asRecord(item);
      return !!record && moonwellRecordIsTrusted(record);
    }).map((item: unknown) => sanitize(item));
    if (trusted.length === 0) return error('moonwell_no_trustworthy_results');
    return {
      content: JSON.stringify({
        provider: 'moonwell',
        screening: { status: 'screened', recommendation: false },
        [collectionKey || 'data']: trusted,
      }),
      isError: false,
    };
  }

  if (!moonwellRecordIsTrusted(root)) return error('moonwell_result_failed_screening');
  return {
    content: JSON.stringify({
      provider: 'moonwell',
      screening: { status: 'screened', recommendation: false },
      data: sanitize(root),
    }),
    isError: false,
  };
}

export function screenPartnerToolResult(input: PartnerToolResultScreenInput): PartnerToolResultScreened {
  if (input.isError) return { content: JSON.stringify(sanitize(unwrap(input.content))), isError: true };
  const provider = input.providerNamespace?.toLowerCase() || providerFromToolName(input.toolName);
  if (!provider) return { content: input.content, isError: false };
  const screener = getRuntimeSkill(provider)?.resultScreener;
  if (screener === 'morpho') return screenMorpho(input.toolName, input.content);
  if (screener === 'moonwell') return screenMoonwell(input.content);
  return error(`${provider}_result_screening_unavailable`);
}
