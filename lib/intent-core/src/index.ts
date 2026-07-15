import { getAddress, isAddress } from 'viem';

export interface TrustedAsset {
  symbol: 'USDC' | 'ETH' | 'WETH';
  address: string | null;
  decimals: number;
  native: boolean;
  source: 'trusted_base_registry';
}

export type NormalizedAmount =
  | { kind: 'exact'; value: string }
  | { kind: 'all' }
  | { kind: 'percentage'; value: number }
  | { kind: 'fiat'; currency: 'USD'; value: string };

export interface SemanticConversationMessage {
  role?: unknown;
  content?: unknown;
  metadata?: unknown;
}

export interface SemanticConversationContext {
  recentMessages: SemanticConversationMessage[];
  walletAddress?: string;
  runtimeChainId: 8453;
}

export interface GroundedRecipient {
  recipient: string | null;
  source: 'message' | 'conversation' | null;
  error?: string;
}

export interface BaseMainnetChainBinding {
  chainId: number;
  chainSource: 'extractor' | 'authenticated_runtime';
  supported: boolean;
}

const FINANCIAL_LANGUAGE =
  /\b(?:send|transfer|pay|swap|exchange|convert|balance|portfolio|security|vault|yield|market|apy|confirm|status|deposit|supply|borrow|repay)\b|(?:отправ|перевед|оплат|обмен|свап|баланс|портфел|безопасност|доходност|хранилищ|рынк|ставк|подтвержд|статус|внес|полож|одолж|погас)/iu;
const APPROVAL_BYPASS_LANGUAGE =
  /\b(?:bypass|skip|avoid)\b.{0,30}\b(?:approval|confirmation)\b|\bwithout\b.{0,20}\b(?:approval|confirmation)\b|(?:обойти|пропустить|без)\s+(?:аппрув|подтверждени|согласован)/iu;
const PROMPT_INJECTION_LANGUAGE =
  /\b(?:ignore|override|disregard)\b.{0,60}\b(?:instruction|system|developer|safety|policy)\b|(?:игнорируй|отмени|переопредели).{0,60}(?:инструкц|системн|безопасност|политик)/iu;
const RECIPIENT_REFERENCE_LANGUAGE =
  /\b(?:him|her|them|that address|same address)\b|(?:ему|ей|им|туда|этому адресу|тот же адрес)/iu;
const ADDRESS_RE = /0x[a-fA-F0-9]{40}/g;

const TRUSTED_ASSETS: Record<string, TrustedAsset> = {
  USDC: {
    symbol: 'USDC',
    address: getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
    decimals: 6,
    native: false,
    source: 'trusted_base_registry',
  },
  ETH: {
    symbol: 'ETH',
    address: null,
    decimals: 18,
    native: true,
    source: 'trusted_base_registry',
  },
  WETH: {
    symbol: 'WETH',
    address: getAddress('0x4200000000000000000000000000000000000006'),
    decimals: 18,
    native: false,
    source: 'trusted_base_registry',
  },
};

export function parseStrictJsonObject(
  content: string,
  expectedKeys: readonly string[],
): Record<string, unknown> | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  const allowed = [...expectedKeys].sort();
  if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index])) {
    return null;
  }
  return object;
}

export function trimmedStringOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value.trim().slice(0, 300) || null : undefined;
}

export function isFinancialLanguage(message: string): boolean {
  return FINANCIAL_LANGUAGE.test(message);
}

export function requestsApprovalBypass(message: string): boolean {
  return APPROVAL_BYPASS_LANGUAGE.test(message);
}

export function looksLikePromptInjection(message: string): boolean {
  return PROMPT_INJECTION_LANGUAGE.test(message);
}

export function bindBaseMainnetChain(
  extractedChainId: number | null,
  authenticatedRuntimeChainId: number,
): BaseMainnetChainBinding {
  const chainId = extractedChainId ?? authenticatedRuntimeChainId;
  return {
    chainId,
    chainSource: extractedChainId === null ? 'authenticated_runtime' : 'extractor',
    supported: authenticatedRuntimeChainId === 8453 && chainId === authenticatedRuntimeChainId,
  };
}

export function normalizePositiveDecimal(value: string): string | null {
  const compact = value.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(?:\.\d+)?$/.test(compact)) return null;
  const numeric = Number(compact);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return compact
    .replace(/^0+(?=\d)/, '')
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');
}

export function normalizeSemanticAmount(raw: string | null): NormalizedAmount | null {
  if (!raw) return null;
  const value = raw
    .trim()
    .toLowerCase()
    .replace(/\u00a0/g, ' ');
  if (/^(?:all|max|everything|все|всё|максимум)$/.test(value)) return { kind: 'all' };
  if (/^(?:half|половин[ау]?)$/.test(value)) return { kind: 'percentage', value: 50 };
  const percentage = value.match(/^(\d+(?:[.,]\d+)?)\s*%$/);
  if (percentage) {
    const numeric = Number(percentage[1].replace(',', '.'));
    return Number.isFinite(numeric) && numeric > 0 && numeric <= 100
      ? { kind: 'percentage', value: numeric }
      : null;
  }
  const fiat = value.match(
    /^(?:\$|usd\s*)?(\d+(?:[.,]\d+)?)\s*(?:usd|dollars?|доллар(?:ов|а)?)?$/i,
  );
  if (fiat && /\$|usd|dollar|доллар/i.test(value)) {
    const normalized = normalizePositiveDecimal(fiat[1]);
    return normalized ? { kind: 'fiat', currency: 'USD', value: normalized } : null;
  }
  const exact = normalizePositiveDecimal(value);
  return exact ? { kind: 'exact', value: exact } : null;
}

export function resolveTrustedAsset(raw: string | null): TrustedAsset | null {
  if (!raw) return null;
  const normalized = raw
    .trim()
    .toUpperCase()
    .replace(/[\s_-]+/g, '');
  const alias = normalized === 'ETHER' || normalized === 'NATIVEETH' ? 'ETH' : normalized;
  const asset = TRUSTED_ASSETS[alias];
  return asset ? { ...asset } : null;
}

export function trustedBaseAssets(): TrustedAsset[] {
  return Object.values(TRUSTED_ASSETS).map((asset) => ({ ...asset }));
}

export function sanitizeSemanticConversationContext(context: SemanticConversationContext): string {
  const recent = context.recentMessages.slice(-8).map((message) => {
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content = typeof message.content === 'string' ? message.content.slice(0, 500) : '';
    const metadata =
      message.metadata && typeof message.metadata === 'object'
        ? (message.metadata as Record<string, unknown>)
        : {};
    const normalized =
      metadata.normalizedIntent && typeof metadata.normalizedIntent === 'object'
        ? metadata.normalizedIntent
        : undefined;
    const pending =
      metadata.pendingAction && typeof metadata.pendingAction === 'object'
        ? metadata.pendingAction
        : undefined;
    return {
      role,
      content,
      ...(normalized ? { normalizedIntent: normalized } : {}),
      ...(pending ? { pendingAction: pending } : {}),
    };
  });
  return JSON.stringify({
    runtimeChainId: context.runtimeChainId,
    walletAddress: context.walletAddress,
    recent,
  });
}

export function sanitizeUntrustedConversation(messages: SemanticConversationMessage[]): string {
  return JSON.stringify(
    messages.slice(-8).map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: typeof message.content === 'string' ? message.content.slice(0, 500) : '',
    })),
  );
}

function contextAddresses(context: SemanticConversationContext): string[] {
  const found = new Set<string>();
  for (const message of context.recentMessages.slice(-12)) {
    const metadata =
      message.metadata && typeof message.metadata === 'object'
        ? (message.metadata as Record<string, unknown>)
        : undefined;
    const normalizedIntent =
      metadata?.normalizedIntent && typeof metadata.normalizedIntent === 'object'
        ? (metadata.normalizedIntent as Record<string, unknown>)
        : undefined;
    const structured = normalizedIntent?.recipient;
    if (typeof structured === 'string' && isAddress(structured)) {
      found.add(getAddress(structured));
    }
    if (message.role !== 'user' || typeof message.content !== 'string') continue;
    for (const match of message.content.match(ADDRESS_RE) || []) {
      if (isAddress(match)) found.add(getAddress(match));
    }
  }
  return [...found];
}

export function groundSemanticRecipient(
  raw: string | null,
  message: string,
  context: SemanticConversationContext,
): GroundedRecipient {
  const inMessage = (message.match(ADDRESS_RE) || [])
    .filter((address) => isAddress(address))
    .map((address) => getAddress(address));
  const uniqueInMessage = [...new Set(inMessage)];
  if (uniqueInMessage.length > 1) {
    return { recipient: null, source: null, error: 'recipient_ambiguous' };
  }
  if (uniqueInMessage.length === 1) {
    if (raw && (!isAddress(raw) || getAddress(raw) !== uniqueInMessage[0])) {
      return { recipient: null, source: null, error: 'recipient_not_grounded' };
    }
    return { recipient: uniqueInMessage[0], source: 'message' };
  }

  if (raw && isAddress(raw)) {
    const checksum = getAddress(raw);
    const candidates = contextAddresses(context);
    return candidates.includes(checksum)
      ? { recipient: checksum, source: 'conversation' }
      : { recipient: null, source: null, error: 'recipient_not_grounded' };
  }

  if (RECIPIENT_REFERENCE_LANGUAGE.test(message)) {
    const candidates = contextAddresses(context);
    if (candidates.length === 1) {
      return { recipient: candidates[0], source: 'conversation' };
    }
    if (candidates.length > 1) {
      return { recipient: null, source: null, error: 'recipient_ambiguous' };
    }
  }
  return { recipient: null, source: null };
}
