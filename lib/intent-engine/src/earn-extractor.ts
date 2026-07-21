import { normalizeSemanticAmount } from '@mioagent/intent-core';
import {
  EarnRouteIntentV1Schema,
  hashEarnRouteIntentV1,
  stableHashV1,
  type EarnOptimizationModeV1,
  type EarnRouteIntentV1,
  type HashV1,
} from '@mioagent/route-domain';
import { decimalToAtomicV1, detectIntentLocaleV1, mapVerificationDepthV1, resolveRouteAssetV1 } from './normalization.js';
import type { IntentLocaleV1 } from './types.js';

// ---------------------------------------------------------------------------
// T61 — deterministic (no-LLM) EN/RU earn intent extractor. Pure and offline so
// it is fully testable with no live provider calls. Earn V1 is USDC-only, on
// Base mainnet; the pinned protocols are Moonwell and Morpho.
// ---------------------------------------------------------------------------

type ProtocolConstraintV1 = EarnRouteIntentV1['protocolConstraint'];
type VerificationDepthV1 = EarnRouteIntentV1['verificationDepth'];

export type EarnIntentIssueV1 =
  | 'amount_required'
  | 'conflicting_amounts'
  | 'asset_unsupported'
  | 'ambiguous_optimization'
  | 'conflicting_protocol_constraints'
  | 'not_earn_goal';

export interface EarnIntentExtractionV1 {
  goal: 'earn' | 'not_earn';
  amountDecimal: string | null;
  optimizationMode: EarnOptimizationModeV1;
  protocolConstraint: ProtocolConstraintV1;
  verificationDepth: VerificationDepthV1;
  executionRequested: boolean;
  locale: IntentLocaleV1;
  issues: EarnIntentIssueV1[];
}

const ZERO_HASH_V1 = `0x${'0'.repeat(64)}` as HashV1;
const EARN_PROTOCOLS = ['moonwell', 'morpho'] as const;

function normalize(message: string): string {
  return message.toLocaleLowerCase('en-US').replace(/ё/g, 'е');
}

function detectEarnGoal(message: string): boolean {
  const text = normalize(message);
  return /\b(earn|yield|apy|deposit|supply|lend|lending|interest)\b/iu.test(text) ||
    /(доходн|размест|внес|депозит|застейк|заработ|под\s+процент)/iu.test(text);
}

function extractAmountDecimal(message: string): { value: string | null; conflicting: boolean } {
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
  const list = [...values];
  if (list.length > 1) return { value: null, conflicting: true };
  return { value: list[0] ?? null, conflicting: false };
}

export function mapEarnOptimizationModeV1(message: string): {
  value: EarnOptimizationModeV1;
  ambiguous: boolean;
} {
  const text = normalize(message);
  const mappings: Array<[EarnOptimizationModeV1, RegExp]> = [
    ['lowest_risk', /\blowest[- ]?risk\b|\bsafest\b|\bleast[- ]?risk\b|минимальн\w*\s+риск|безопасн\w*|надежн\w*|меньш\w*\s+риск/iu],
    ['highest_liquidity', /\bhighest[- ]?liquidity\b|\bmost[- ]?liquid\b|\bdeep\w*\s+liquidity\b|максимальн\w*\s+ликвидн|больше\s+ликвидн|глубок\w*\s+ликвидн/iu],
    ['simplest_route', /\bsimpl\w*\s+(?:route|withdraw\w*)\b|\beasier\s+withdraw\w*\b|\beasy\s+withdraw\w*\b|\bprefer\s+easier\b|прост\w*\s+(?:маршрут|вывод)|легч\w*\s+вывод|проще\s+вывод/iu],
    ['best_net_yield', /\bbest\s+(?:net\s+)?(?:yield|apy|return)\b|\bhighest\s+(?:net\s+)?(?:yield|apy)\b|лучш\w*\s+(?:чист\w*\s+)?(?:доходн|apy|процент)|максимальн\w*\s+доходн/iu],
  ];
  const matches = mappings.filter(([, pattern]) => pattern.test(text)).map(([mode]) => mode);
  const unique = [...new Set(matches)];
  if (unique.length > 1) return { value: 'best_net_yield', ambiguous: true };
  return { value: unique[0] ?? 'best_net_yield', ambiguous: false };
}

export function mapEarnProtocolConstraintV1(message: string): {
  value: ProtocolConstraintV1;
  conflicting: boolean;
} {
  const text = normalize(message);
  const include = new Set<string>();
  const exclude = new Set<string>();
  for (const protocol of EARN_PROTOCOLS) {
    const negativePattern = new RegExp(
      `(?:do\\s+not\\s+use|don['’]?t\\s+use|avoid|exclude|without|skip|не\\s+использ\\w*|исключ\\w*|без).{0,24}\\b${protocol}\\b`,
      'giu',
    );
    const negative = negativePattern.test(text);
    const withoutNegative = text.replace(negativePattern, ' ');
    const positive = new RegExp(
      `(?:use|only|используй|только).{0,24}\\b${protocol}\\b|\\b${protocol}\\b.{0,12}(?:only|только)`,
      'iu',
    ).test(withoutNegative);
    if (negative) exclude.add(protocol);
    if (positive) include.add(protocol);
  }
  if (include.size > 0 && exclude.size > 0) {
    return { value: { mode: 'any', protocols: [] }, conflicting: true };
  }
  if (include.size > 0) return { value: { mode: 'include_only', protocols: [...include].sort() }, conflicting: false };
  if (exclude.size > 0) return { value: { mode: 'exclude', protocols: [...exclude].sort() }, conflicting: false };
  return { value: { mode: 'any', protocols: [] }, conflicting: false };
}

function mapEarnExecutionRequestedV1(message: string): boolean {
  const text = normalize(message);
  if (/\b(?:do not|don['’]?t|not)\s+(?:execute|deposit|supply)\b|\bjust\s+(?:compare|show|quote)\b|\bcompare\b|не\s+(?:исполняй|вноси|размещай)|сравни\w*|покаж\w*/iu.test(text)) {
    return false;
  }
  if (/\b(?:execute|proceed|now|go ahead)\b|\bdeposit\s+now\b|сейчас|исполн\w*|немедленн\w*/iu.test(text)) {
    return true;
  }
  return false;
}

/** Non-USDC deposit asset is unsupported in earn V1 (spec §2/§3 — USDC only). */
function hasUnsupportedAsset(message: string): boolean {
  const text = normalize(message);
  const mentionsUsdc = /\busdc\b/iu.test(text);
  const mentionsOther = /\b(weth|ether|dai|usdt|cbbtc|wbtc)\b/iu.test(text) || (/\beth\b/iu.test(text) && !mentionsUsdc);
  return mentionsOther && !mentionsUsdc;
}

export function extractEarnIntentV1(message: string): EarnIntentExtractionV1 {
  const locale = detectIntentLocaleV1(message);
  const issues: EarnIntentIssueV1[] = [];
  const goal = detectEarnGoal(message) ? 'earn' : 'not_earn';

  const amount = extractAmountDecimal(message);
  if (amount.conflicting) issues.push('conflicting_amounts');
  if (hasUnsupportedAsset(message)) issues.push('asset_unsupported');

  const optimization = mapEarnOptimizationModeV1(message);
  if (optimization.ambiguous) issues.push('ambiguous_optimization');
  const protocol = mapEarnProtocolConstraintV1(message);
  if (protocol.conflicting) issues.push('conflicting_protocol_constraints');

  return {
    goal,
    amountDecimal: amount.value,
    optimizationMode: optimization.value,
    protocolConstraint: protocol.value,
    verificationDepth: mapVerificationDepthV1(message),
    executionRequested: mapEarnExecutionRequestedV1(message),
    locale,
    issues,
  };
}

export type EarnIntentResolutionV1 =
  | { status: 'ready'; intent: EarnRouteIntentV1; extraction: EarnIntentExtractionV1; issues: [] }
  | { status: 'needs_clarification'; intent: null; extraction: EarnIntentExtractionV1; issues: EarnIntentIssueV1[] }
  | { status: 'unsupported'; intent: null; extraction: EarnIntentExtractionV1; issues: EarnIntentIssueV1[] };

export interface ResolveEarnIntentInputV1 {
  message: string;
  tenantId: string;
  walletAddress: `0x${string}`;
  now: Date;
}

/** Grounds an EN/RU earn request into a validated EarnRouteIntentV1 (USDC on
 * Base). Returns needs_clarification / unsupported instead of ever inventing a
 * missing amount, asset, or execution permission. */
export function resolveEarnIntentV1(input: ResolveEarnIntentInputV1): EarnIntentResolutionV1 {
  const extraction = extractEarnIntentV1(input.message);
  if (extraction.goal !== 'earn') {
    return { status: 'unsupported', intent: null, extraction, issues: ['not_earn_goal', ...extraction.issues] };
  }
  const blocking = extraction.issues.filter(
    (code) => code === 'conflicting_amounts' || code === 'asset_unsupported' || code === 'conflicting_protocol_constraints',
  );
  if (blocking.length > 0) {
    return { status: 'needs_clarification', intent: null, extraction, issues: extraction.issues };
  }
  if (!extraction.amountDecimal) {
    return { status: 'needs_clarification', intent: null, extraction, issues: [...extraction.issues, 'amount_required'] };
  }

  const usdc = resolveRouteAssetV1('USDC');
  if (!usdc) {
    return { status: 'needs_clarification', intent: null, extraction, issues: [...extraction.issues, 'asset_unsupported'] };
  }
  const amountAtomic = decimalToAtomicV1(extraction.amountDecimal, usdc.decimals);
  if (!amountAtomic) {
    return { status: 'needs_clarification', intent: null, extraction, issues: [...extraction.issues, 'amount_required'] };
  }

  const nowIso = input.now.toISOString();
  const draft = {
    schemaVersion: 'earn-route-intent/v1' as const,
    id: `earn-intent:${stableHashV1('earn-intent', {
      tenantId: input.tenantId,
      walletAddress: input.walletAddress.toLowerCase(),
      amountDecimal: extraction.amountDecimal,
      optimizationMode: extraction.optimizationMode,
      protocolConstraint: extraction.protocolConstraint,
    }).slice(2, 26)}`,
    tenantId: input.tenantId,
    walletAddress: input.walletAddress,
    chainId: 8453 as const,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: 'ready' as const,
    intentHash: ZERO_HASH_V1,
    goal: 'earn' as const,
    asset: usdc,
    amount: { asset: usdc, amountAtomic, amountDecimal: extraction.amountDecimal },
    optimizationMode: extraction.optimizationMode,
    verificationDepth: extraction.verificationDepth,
    protocolConstraint: extraction.protocolConstraint,
    executionRequested: extraction.executionRequested,
  };
  const intent = EarnRouteIntentV1Schema.parse({
    ...draft,
    intentHash: hashEarnRouteIntentV1(draft as unknown as EarnRouteIntentV1),
  });
  return { status: 'ready', intent, extraction, issues: [] };
}
