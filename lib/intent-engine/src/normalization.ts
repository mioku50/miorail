import {
  normalizeSemanticAmount,
  resolveTrustedAsset,
  trustedBaseAssets,
  type TrustedAsset,
} from '@mioagent/intent-core';
import type { AssetRefV1, RouteIntentV1 } from '@mioagent/route-domain';
import type {
  ClarificationCodeV1,
  ClarificationV1,
  IntentIssueCodeV1,
  IntentIssueV1,
  IntentLocaleV1,
  IntentRuntimeContextV2,
  PendingSwapIntentV2,
  SwapIntentExtractionV2,
} from './types.js';

export const DEFAULT_SLIPPAGE_BPS_V2 = 50;
export const PENDING_INTENT_TTL_MS_V2 = 10 * 60 * 1_000;

type OptimizationModeV1 = RouteIntentV1['optimizationMode'];
type VerificationDepthV1 = RouteIntentV1['verificationDepth'];
type ProtocolConstraintV1 = RouteIntentV1['protocolConstraint'];
type SlippageConstraintV1 = RouteIntentV1['slippageConstraint'];

export interface GroundedSwapFieldsV2 {
  amountDecimal: string | null;
  fromAsset: AssetRefV1 | null;
  toAsset: AssetRefV1 | null;
  optimizationMode: OptimizationModeV1;
  verificationDepth: VerificationDepthV1;
  protocolConstraint: ProtocolConstraintV1;
  slippageConstraint: SlippageConstraintV1;
  executionRequested: boolean;
  pendingIntent: PendingSwapIntentV2 | null;
  issues: IntentIssueV1[];
}

const ISSUE_PRIORITY: IntentIssueCodeV1[] = [
  'prompt_injection_detected',
  'approval_bypass_forbidden',
  'server_signing_forbidden',
  'asset_address_unsafe',
  'chain_unsupported',
  'conflicting_protocol_constraints',
  'conflicting_amounts',
  'unsupported_goal',
  'extractor_invalid',
  'extractor_field_ungrounded',
  'context_ambiguous',
  'protocol_conflict',
  'slippage_invalid',
  'exact_amount_required',
  'amount_required',
  'asset_unknown',
  'from_asset_required',
  'to_asset_required',
  'asset_pair_invalid',
  'intent_ambiguous',
];

const CLARIFICATION_MESSAGES: Record<ClarificationCodeV1, Record<IntentLocaleV1, string>> = {
  amount_required: {
    en: 'What exact amount should be swapped?',
    ru: 'Какую точную сумму нужно обменять?',
  },
  exact_amount_required: {
    en: 'Please provide one exact token amount instead of a percentage or estimate.',
    ru: 'Укажите одну точную сумму токена, а не процент или приблизительное значение.',
  },
  from_asset_required: {
    en: 'Which exact Base token should be swapped?',
    ru: 'Какой именно токен в сети Base нужно обменять?',
  },
  to_asset_required: {
    en: 'Which exact token should be received?',
    ru: 'Какой именно токен нужно получить?',
  },
  asset_pair_invalid: {
    en: 'The source and destination assets must be different.',
    ru: 'Исходный и получаемый токены должны отличаться.',
  },
  asset_unknown: {
    en: 'Which trusted Base token do you mean? Supported Swap V1 assets are USDC, ETH, and WETH.',
    ru: 'Какой доверенный токен Base вы имеете в виду? Swap V1 поддерживает USDC, ETH и WETH.',
  },
  chain_unsupported: {
    en: 'Swap Intent V2 supports Base mainnet only.',
    ru: 'Swap Intent V2 поддерживает только Base mainnet.',
  },
  protocol_conflict: {
    en: 'Which single protocol constraint should be used?',
    ru: 'Какое одно ограничение по протоколу нужно использовать?',
  },
  slippage_invalid: {
    en: 'What valid maximum slippage percentage should be used?',
    ru: 'Какой допустимый максимальный процент проскальзывания использовать?',
  },
  intent_ambiguous: {
    en: 'Please restate one unambiguous swap request.',
    ru: 'Сформулируйте один однозначный запрос на обмен.',
  },
};

function issue(
  code: IntentIssueCodeV1,
  field: string,
  severity: IntentIssueV1['severity'],
  message: string,
): IntentIssueV1 {
  return { code, field, severity, message };
}

export function sortIntentIssuesV1(issues: IntentIssueV1[]): IntentIssueV1[] {
  const unique = new Map<string, IntentIssueV1>();
  for (const item of issues) unique.set(`${item.code}\u0000${item.field}`, item);
  return [...unique.values()].sort((left, right) => {
    const priority = ISSUE_PRIORITY.indexOf(left.code) - ISSUE_PRIORITY.indexOf(right.code);
    return priority || left.field.localeCompare(right.field) || left.code.localeCompare(right.code);
  });
}

export function detectIntentLocaleV1(message: string): IntentLocaleV1 {
  return /[А-Яа-яЁё]/u.test(message) ? 'ru' : 'en';
}

export function createClarificationV1(
  code: ClarificationCodeV1,
  missingFields: string[],
  locale: IntentLocaleV1,
): ClarificationV1 {
  return {
    code,
    message: CLARIFICATION_MESSAGES[code][locale],
    missingFields: [...new Set(missingFields)],
    locale,
  };
}

function normalizeText(message: string): string {
  return message.toLocaleLowerCase('en-US').replace(/ё/g, 'е');
}

function toAssetRef(asset: TrustedAsset): AssetRefV1 {
  const address = asset.address?.toLowerCase() as `0x${string}` | undefined;
  return {
    assetId: asset.native ? 'eip155:8453/native' : `eip155:8453/erc20:${address}`,
    chainId: 8453,
    kind: asset.native ? 'native' : 'erc20',
    address: address ?? null,
    symbol: asset.symbol,
    decimals: asset.decimals,
  };
}

export function resolveRouteAssetV1(raw: string | null): AssetRefV1 | null {
  const bySymbol = resolveTrustedAsset(raw);
  if (bySymbol) return toAssetRef(bySymbol);
  if (!raw) return null;
  const lowered = raw.toLowerCase();
  const byAddress = trustedBaseAssets().find((asset) => asset.address?.toLowerCase() === lowered);
  return byAddress ? toAssetRef(byAddress) : null;
}

function assetOccurrences(message: string): AssetRefV1[] {
  const found: Array<{ index: number; asset: AssetRefV1 }> = [];
  const symbolPattern = /\b(?:USDC|WETH|ETH|ETHER)\b/giu;
  for (const match of message.matchAll(symbolPattern)) {
    const asset = resolveRouteAssetV1(match[0]);
    if (asset) found.push({ index: match.index ?? 0, asset });
  }
  for (const asset of trustedBaseAssets()) {
    if (!asset.address) continue;
    const index = message.toLowerCase().indexOf(asset.address.toLowerCase());
    if (index >= 0) found.push({ index, asset: toAssetRef(asset) });
  }
  found.sort((left, right) => left.index - right.index);
  const seen = new Set<string>();
  return found.flatMap(({ asset }) => {
    if (seen.has(asset.assetId)) return [];
    seen.add(asset.assetId);
    return [asset];
  });
}

function rawFieldIsGrounded(raw: string, message: string): boolean {
  return normalizeText(message).includes(normalizeText(raw).trim());
}

function addressSafetyIssues(message: string): IntentIssueV1[] {
  const tokens = message.match(/\b0x[0-9a-zA-Z]*/g) ?? [];
  const trusted = new Set(
    trustedBaseAssets().flatMap((asset) => (asset.address ? [asset.address.toLowerCase()] : [])),
  );
  for (const token of tokens) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(token) || !trusted.has(token.toLowerCase())) {
      return [
        issue(
          'asset_address_unsafe',
          'assets',
          'rejection',
          'Swap V1 rejects malformed or untrusted token addresses',
        ),
      ];
    }
  }
  return [];
}

function amountCandidates(message: string): string[] {
  const scrubbed = message.replace(/\b0x[0-9a-zA-Z]*/g, ' ');
  const values = new Set<string>();
  for (const match of scrubbed.matchAll(/\b\d+(?:[.,]\d+)?\b/g)) {
    const after = scrubbed.slice((match.index ?? 0) + match[0].length);
    if (/^\s*%/.test(after)) continue;
    const normalized = normalizeSemanticAmount(match[0]);
    if (normalized?.kind !== 'exact') continue;
    if (normalized.value === '8453' || normalized.value === '84532') continue;
    values.add(normalized.value);
  }
  return [...values];
}

function hasRelativeOrApproximateAmount(message: string): boolean {
  const normalized = normalizeText(message);
  const relative =
    /\b(?:all|everything|half|some|approximately|about|around)\b|(?:^|\s)(?:все|всё|половин\w*|немного|сколько-нибудь|примерно|около)(?:\s|$)/u.test(
      normalized,
    );
  const percentWithoutSlippage =
    /\d+(?:[.,]\d+)?\s*%/.test(normalized) && !/(?:slippage|проскальзыван)/u.test(normalized);
  return relative || percentWithoutSlippage;
}

function normalizeExtractedAmount(
  extraction: SwapIntentExtractionV2,
  message: string,
  pending: PendingSwapIntentV2 | null,
): { value: string | null; issues: IntentIssueV1[]; conflictsPending: boolean } {
  const issues: IntentIssueV1[] = [];
  const candidates = amountCandidates(message);
  if (candidates.length > 1) {
    issues.push(
      issue(
        'conflicting_amounts',
        'amount',
        'rejection',
        'The request contains multiple conflicting exact amounts',
      ),
    );
    return { value: null, issues, conflictsPending: false };
  }
  if (hasRelativeOrApproximateAmount(message)) {
    issues.push(
      issue(
        'exact_amount_required',
        'amount',
        'clarification',
        'Swap V1 requires one exact amount',
      ),
    );
    return { value: null, issues, conflictsPending: false };
  }

  let current = candidates[0] ?? null;
  if (extraction.amount) {
    const parsed = normalizeSemanticAmount(extraction.amount);
    if (!rawFieldIsGrounded(extraction.amount, message)) {
      issues.push(
        issue(
          'extractor_field_ungrounded',
          'amount',
          'rejection',
          'Extracted amount is not grounded in the current user request',
        ),
      );
      return { value: null, issues, conflictsPending: false };
    }
    if (!parsed || parsed.kind !== 'exact') {
      issues.push(
        issue(
          'exact_amount_required',
          'amount',
          'clarification',
          'Swap V1 requires one exact amount',
        ),
      );
      return { value: null, issues, conflictsPending: false };
    }
    if (current && current !== parsed.value) {
      issues.push(
        issue(
          'conflicting_amounts',
          'amount',
          'rejection',
          'Extracted amount conflicts with the current user request',
        ),
      );
      return { value: null, issues, conflictsPending: false };
    }
    current = parsed.value;
  }

  const conflictsPending = Boolean(
    current && pending?.amountDecimal && current !== pending.amountDecimal,
  );
  if (conflictsPending) {
    issues.push(
      issue(
        'intent_ambiguous',
        'amount',
        'clarification',
        'Current amount conflicts with the pending swap intent',
      ),
    );
  }
  return {
    value: conflictsPending ? current : (current ?? pending?.amountDecimal ?? null),
    issues,
    conflictsPending,
  };
}

function groundedAssets(
  extraction: SwapIntentExtractionV2,
  message: string,
  pending: PendingSwapIntentV2 | null,
  allowPending: boolean,
): { fromAsset: AssetRefV1 | null; toAsset: AssetRefV1 | null; issues: IntentIssueV1[] } {
  const issues: IntentIssueV1[] = [...addressSafetyIssues(message)];
  const occurrences = assetOccurrences(message);

  const parseExtracted = (raw: string | null, field: 'fromAsset' | 'toAsset') => {
    if (!raw) return null;
    if (!rawFieldIsGrounded(raw, message)) {
      issues.push(
        issue(
          'extractor_field_ungrounded',
          field,
          'rejection',
          `Extracted ${field} is not grounded in the current user request`,
        ),
      );
      return null;
    }
    const asset = resolveRouteAssetV1(raw);
    if (!asset) {
      issues.push(
        issue(
          'asset_unknown',
          field,
          'clarification',
          `Extracted ${field} is not in the trusted Base asset registry`,
        ),
      );
    }
    return asset;
  };

  let fromAsset = parseExtracted(extraction.fromAsset, 'fromAsset');
  let toAsset = parseExtracted(extraction.toAsset, 'toAsset');

  if (occurrences.length >= 2) {
    const [orderedFrom, orderedTo] = occurrences;
    if (
      (fromAsset && fromAsset.assetId !== orderedFrom.assetId) ||
      (toAsset && toAsset.assetId !== orderedTo.assetId)
    ) {
      issues.push(
        issue(
          'extractor_field_ungrounded',
          'assets',
          'rejection',
          'Extracted asset direction conflicts with the current request',
        ),
      );
    } else {
      fromAsset = orderedFrom;
      toAsset = orderedTo;
    }
  } else if (occurrences.length === 1) {
    const only = occurrences[0];
    if (allowPending && pending?.fromAssetSymbol && !pending.toAssetSymbol) {
      const pendingFrom = resolveRouteAssetV1(pending.fromAssetSymbol);
      if (pendingFrom?.assetId !== only.assetId) toAsset ??= only;
    } else if (allowPending && pending?.toAssetSymbol && !pending.fromAssetSymbol) {
      const pendingTo = resolveRouteAssetV1(pending.toAssetSymbol);
      if (pendingTo?.assetId !== only.assetId) fromAsset ??= only;
    } else {
      fromAsset ??= only;
    }
  }

  if (allowPending) {
    fromAsset ??= resolveRouteAssetV1(pending?.fromAssetSymbol ?? null);
    toAsset ??= resolveRouteAssetV1(pending?.toAssetSymbol ?? null);
  }

  return { fromAsset, toAsset, issues };
}

export function mapOptimizationModeV1(message: string): {
  value: OptimizationModeV1;
  issues: IntentIssueV1[];
} {
  const normalized = normalizeText(message);
  const mappings: Array<[OptimizationModeV1, RegExp]> = [
    ['mev_protected', /\bmev[- ]?protected\b|\bmev protection\b|защит[а-я]*\s+от\s+mev/iu],
    ['lowest_risk', /\blowest risk\b|\bsafest\b|минимальн[а-я]*\s+риск|безопаснее/iu],
    ['lowest_fees', /\blowest fees?\b|\bcheapest\b|меньше\s+комисси|минимальн[а-я]*\s+комисси/iu],
    ['simplest_route', /\bsimplest route\b|\bfewer calls\b|прост[а-я]*\s+маршрут/iu],
    ['fastest_execution', /\bfastest(?: execution)?\b|быстр(?:ее|ейш[а-я]*)/iu],
    ['best_net_result', /\bbest (?:net )?(?:route|result)\b|лучш[а-я]*\s+результат/iu],
  ];
  const matches = mappings.filter(([, pattern]) => pattern.test(normalized)).map(([mode]) => mode);
  const unique = [...new Set(matches)];
  if (unique.length > 1) {
    return {
      value: 'best_net_result',
      issues: [
        issue(
          'intent_ambiguous',
          'optimizationMode',
          'clarification',
          'The request contains conflicting optimization preferences',
        ),
      ],
    };
  }
  return { value: unique[0] ?? 'best_net_result', issues: [] };
}

export function mapVerificationDepthV1(message: string): VerificationDepthV1 {
  const normalized = normalizeText(message);
  if (/\bmaximum\b|\bdeepest\b|максимальн[а-я]*\s+проверк/iu.test(normalized)) return 'maximum';
  if (
    /\bdeeper\b|\bverify more\b|\bcheck more deeply\b|дополнительн[а-я]*\s+проверк|проверь\s+глубже/iu.test(
      normalized,
    )
  ) {
    return 'enhanced';
  }
  return 'standard';
}

export function mapProtocolConstraintV1(message: string): {
  value: ProtocolConstraintV1;
  issues: IntentIssueV1[];
} {
  const normalized = normalizeText(message);
  const known = ['uniswap', 'kyberswap'] as const;
  const include = new Set<string>();
  const exclude = new Set<string>();

  if (/(?:uniswap|kyberswap).{0,20}(?:\bor\b|или).{0,20}(?:uniswap|kyberswap)/iu.test(normalized)) {
    return {
      value: { mode: 'any', protocols: [] },
      issues: [
        issue(
          'protocol_conflict',
          'protocolConstraint',
          'clarification',
          'Alternative protocol wording is ambiguous',
        ),
      ],
    };
  }

  for (const protocol of known) {
    const negativePattern = new RegExp(
      `(?:do\\s+not\\s+use|don['’]?t\\s+use|avoid|exclude|without|не\\s+используй|исключи|без).{0,24}\\b${protocol}\\b`,
      'giu',
    );
    const negative = negativePattern.test(normalized);
    const withoutNegativeConstraint = normalized.replace(negativePattern, ' ');
    const positive = new RegExp(
      `(?:use|only|используй|только).{0,24}\\b${protocol}\\b|\\b${protocol}\\b.{0,12}(?:only|только)`,
      'iu',
    ).test(withoutNegativeConstraint);
    if (negative) exclude.add(protocol);
    if (positive) include.add(protocol);
  }

  const unknownUse = (
    normalized.match(/\buse\s+only\s+([a-z][a-z0-9.-]*)/iu)?.[1] ??
    normalized.match(/\buse\s+([a-z][a-z0-9.-]*)\s+only\b/iu)?.[1] ??
    normalized.match(/\b(?:avoid|exclude)\s+([a-z][a-z0-9.-]*)/iu)?.[1] ??
    normalized.match(/(?:используй|избегай)\s+(?:только\s+)?([a-z][a-z0-9.-]*)/iu)?.[1] ??
    normalized.match(/\buse\s+([a-z][a-z0-9.-]*)/iu)?.[1]
  )?.replace(/[.-]+$/, '');
  const nonProtocolUseWords = new Set(['a', 'base', 'best', 'mev', 'the', 'maximum', 'standard']);
  if (
    unknownUse &&
    !known.includes(unknownUse as (typeof known)[number]) &&
    !nonProtocolUseWords.has(unknownUse)
  ) {
    return {
      value: { mode: 'any', protocols: [] },
      issues: [
        issue(
          'protocol_conflict',
          'protocolConstraint',
          'clarification',
          'Requested protocol does not have a canonical Swap V1 identifier',
        ),
      ],
    };
  }

  if (include.size > 0 && exclude.size > 0) {
    return {
      value: { mode: 'any', protocols: [] },
      issues: [
        issue(
          'conflicting_protocol_constraints',
          'protocolConstraint',
          'rejection',
          'Include-only and exclude protocol constraints cannot be combined',
        ),
      ],
    };
  }
  if (include.size > 0)
    return { value: { mode: 'include_only', protocols: [...include].sort() }, issues: [] };
  if (exclude.size > 0)
    return { value: { mode: 'exclude', protocols: [...exclude].sort() }, issues: [] };
  return { value: { mode: 'any', protocols: [] }, issues: [] };
}

export function mapSlippageConstraintV1(message: string): {
  value: SlippageConstraintV1;
  issues: IntentIssueV1[];
} {
  const normalized = normalizeText(message);
  const hasSlippage = /slippage|проскальзыван/iu.test(normalized);
  if (!hasSlippage) {
    return { value: { maxBps: DEFAULT_SLIPPAGE_BPS_V2, source: 'default' }, issues: [] };
  }
  const before = normalized.match(
    /(\d+(?:[.,]\d+)?)\s*%\s*(?:max(?:imum)?\s+)?(?:slippage|проскальзыван)/iu,
  )?.[1];
  const after = normalized.match(
    /(?:slippage|проскальзыван)[^\d]{0,32}(\d+(?:[.,]\d+)?)\s*%/iu,
  )?.[1];
  const raw = before ?? after;
  const percent = raw ? Number(raw.replace(',', '.')) : Number.NaN;
  const bps = percent * 100;
  if (!Number.isFinite(percent) || percent < 0 || percent > 100 || !Number.isInteger(bps)) {
    return {
      value: { maxBps: DEFAULT_SLIPPAGE_BPS_V2, source: 'default' },
      issues: [
        issue(
          'slippage_invalid',
          'slippageConstraint',
          'clarification',
          'Explicit slippage must be a valid percentage representable in basis points',
        ),
      ],
    };
  }
  return { value: { maxBps: bps, source: 'user' }, issues: [] };
}

export function mapExecutionRequestedV1(message: string): boolean {
  const normalized = normalizeText(message);
  if (
    /\b(?:do not|don['’]?t|not)\s+(?:execute|trade|swap)\b|\bquote(?:-only)?\b|\bcompare routes?\b|не\s+(?:исполняй|выполняй|совершай)|только\s+котиров|сравни\w*\s+маршрут/iu.test(
      normalized,
    )
  ) {
    return false;
  }
  if (/\b(?:prepare|swap|exchange|convert)\b|(?:подготов|обмен|свап)/iu.test(normalized)) {
    return true;
  }
  return false;
}

function validPendingIntents(
  context: IntentRuntimeContextV2,
  walletAddress: string,
): PendingSwapIntentV2[] {
  const now = Date.parse(context.requestedAt);
  if (!Number.isFinite(now)) return [];
  const pendingIntents = Array.isArray(context.pendingIntents) ? context.pendingIntents : [];
  return pendingIntents.filter((pending) => {
    if (
      !pending ||
      typeof pending !== 'object' ||
      typeof pending.tenantId !== 'string' ||
      typeof pending.walletAddress !== 'string' ||
      typeof pending.createdAt !== 'string' ||
      typeof pending.expiresAt !== 'string' ||
      typeof pending.sourceRequestId !== 'string' ||
      (pending.amountDecimal !== null && typeof pending.amountDecimal !== 'string') ||
      ![null, 'USDC', 'ETH', 'WETH'].includes(pending.fromAssetSymbol) ||
      ![null, 'USDC', 'ETH', 'WETH'].includes(pending.toAssetSymbol)
    ) {
      return false;
    }
    const normalizedAmount = pending.amountDecimal
      ? normalizeSemanticAmount(pending.amountDecimal)
      : null;
    if (
      pending.amountDecimal !== null &&
      (normalizedAmount?.kind !== 'exact' || normalizedAmount.value !== pending.amountDecimal)
    ) {
      return false;
    }
    const createdAt = Date.parse(pending.createdAt);
    const expiresAt = Date.parse(pending.expiresAt);
    return (
      pending.schemaVersion === 'pending-swap-intent/v2' &&
      pending.tenantId === context.tenantId &&
      pending.walletAddress.toLowerCase() === walletAddress.toLowerCase() &&
      pending.chainId === 8453 &&
      Number.isFinite(createdAt) &&
      Number.isFinite(expiresAt) &&
      createdAt <= now &&
      now <= expiresAt &&
      now - createdAt <= PENDING_INTENT_TTL_MS_V2
    );
  });
}

export function groundSwapFieldsV2(input: {
  message: string;
  extraction: SwapIntentExtractionV2;
  context: IntentRuntimeContextV2;
  walletAddress: string;
}): GroundedSwapFieldsV2 {
  const issues: IntentIssueV1[] = [];
  const pendingCandidates = validPendingIntents(input.context, input.walletAddress);
  if (pendingCandidates.length > 1) {
    issues.push(
      issue(
        'context_ambiguous',
        'context.pendingIntents',
        'clarification',
        'More than one recent pending intent matches this tenant and wallet',
      ),
    );
  }
  const pending = pendingCandidates.length === 1 ? pendingCandidates[0] : null;
  const amount = normalizeExtractedAmount(input.extraction, input.message, pending);
  issues.push(...amount.issues);
  const allowPending = !amount.conflictsPending;
  const assets = groundedAssets(input.extraction, input.message, pending, allowPending);
  issues.push(...assets.issues);

  const optimization = mapOptimizationModeV1(input.message);
  const protocol = mapProtocolConstraintV1(input.message);
  const slippage = mapSlippageConstraintV1(input.message);
  issues.push(...optimization.issues, ...protocol.issues, ...slippage.issues);

  return {
    amountDecimal: amount.value,
    fromAsset: assets.fromAsset,
    toAsset: assets.toAsset,
    optimizationMode: optimization.value,
    verificationDepth: mapVerificationDepthV1(input.message),
    protocolConstraint: protocol.value,
    slippageConstraint: slippage.value,
    executionRequested: mapExecutionRequestedV1(input.message),
    pendingIntent: pending,
    issues: sortIntentIssuesV1(issues),
  };
}

export function decimalToAtomicV1(value: string, decimals: number): string | null {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) return null;
  const atomic = `${whole}${fraction.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/, '');
  return atomic || '0';
}

export function buildPendingSwapIntentV2(input: {
  context: IntentRuntimeContextV2;
  walletAddress: string;
  fields: GroundedSwapFieldsV2;
}): PendingSwapIntentV2 | null {
  const hasGroundedValue = Boolean(
    input.fields.amountDecimal || input.fields.fromAsset || input.fields.toAsset,
  );
  if (!hasGroundedValue) return null;
  if (
    input.fields.fromAsset &&
    input.fields.toAsset &&
    input.fields.fromAsset.assetId === input.fields.toAsset.assetId
  ) {
    return null;
  }
  const createdAt = new Date(input.context.requestedAt);
  return {
    schemaVersion: 'pending-swap-intent/v2',
    tenantId: input.context.tenantId,
    walletAddress: input.walletAddress,
    chainId: 8453,
    sourceRequestId: input.context.requestId,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + PENDING_INTENT_TTL_MS_V2).toISOString(),
    amountDecimal: input.fields.amountDecimal,
    fromAssetSymbol:
      (input.fields.fromAsset?.symbol as PendingSwapIntentV2['fromAssetSymbol']) ?? null,
    toAssetSymbol: (input.fields.toAsset?.symbol as PendingSwapIntentV2['toAssetSymbol']) ?? null,
  };
}
