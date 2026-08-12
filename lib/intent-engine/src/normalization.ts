import {
  normalizeSemanticAmount,
  resolveTrustedAsset,
  trustedBaseAssets,
  type TrustedAsset,
} from '@mioagent/intent-core';
import type { AssetRefV1, RouteIntentV1 } from '@mioagent/route-domain';
import type {
  CarriedProtocolConstraintV2,
  CarriedSwapConstraintsV2,
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
  /** The four fields above, minus everything the user never asked for. This is
   * what a follow-up turn is allowed to inherit — see CarriedSwapConstraintsV2. */
  carried: CarriedSwapConstraintsV2;
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

/**
 * Tokens identified on chain for THIS message, and nothing else.
 *
 * Deliberately per-request rather than a growing registry: an asset earns its
 * place by the user naming its address in the words being read right now. A
 * cache would let one request's token answer another request's symbol, which
 * is the whole failure mode this design exists to avoid.
 */
export type IdentifiedAssetsV1 = readonly AssetRefV1[];

/** The asset a raw field names — trusted by symbol or address, or identified
 * on chain for this message. Symbols resolve ONLY against the trusted table:
 * an identified token is reachable by its address, never by the name its own
 * contract answers, because two contracts can answer the same name. */
export function resolveRouteAssetV1(
  raw: string | null,
  identified: IdentifiedAssetsV1 = [],
): AssetRefV1 | null {
  const bySymbol = resolveTrustedAsset(raw);
  if (bySymbol) return toAssetRef(bySymbol);
  if (!raw) return null;
  const lowered = raw.toLowerCase();
  const byAddress = trustedBaseAssets().find((asset) => asset.address?.toLowerCase() === lowered);
  if (byAddress) return toAssetRef(byAddress);
  return identified.find((asset) => asset.address?.toLowerCase() === lowered) ?? null;
}

interface AssetOccurrenceV1 {
  index: number;
  asset: AssetRefV1;
}

// Ticker or plain name. The Cyrillic forms need lookarounds rather than \b,
// which is ASCII-only; the alias table decides what each spelling resolves to.
const ASSET_SYMBOL_PATTERN_V1 =
  /(?<![\p{L}\p{N}])(?:USDC|WETH|ETH|ETHER|ЭФИР\p{L}*|ЮСД[СЦ])(?![\p{L}\p{N}])/giu;

function assetOccurrences(message: string, identified: IdentifiedAssetsV1 = []): AssetOccurrenceV1[] {
  const found: AssetOccurrenceV1[] = [];
  const symbolPattern = new RegExp(ASSET_SYMBOL_PATTERN_V1);
  for (const match of message.matchAll(symbolPattern)) {
    const asset = resolveRouteAssetV1(match[0], identified);
    if (asset) found.push({ index: match.index ?? 0, asset });
  }
  for (const asset of trustedBaseAssets()) {
    if (!asset.address) continue;
    const index = message.toLowerCase().indexOf(asset.address.toLowerCase());
    if (index >= 0) found.push({ index, asset: toAssetRef(asset) });
  }
  // An identified token appears where its ADDRESS appears. It has a symbol,
  // and that symbol is never matched here — the contract does not get to
  // claim a position in the sentence by calling itself USDC.
  for (const asset of identified) {
    if (!asset.address) continue;
    const index = message.toLowerCase().indexOf(asset.address.toLowerCase());
    if (index >= 0) found.push({ index, asset });
  }
  found.sort((left, right) => left.index - right.index);
  const seen = new Set<string>();
  return found.flatMap((occurrence) => {
    if (seen.has(occurrence.asset.assetId)) return [];
    seen.add(occurrence.asset.assetId);
    return [occurrence];
  });
}

// A single named asset is not automatically the source. "Swap 0.1 to ETH"
// names the destination and leaves the source unsaid; reading it as the source
// produced a same-asset pair and asked the user why the two sides matched.
// Only a marker standing immediately before the symbol counts as direction.
// \b cannot open these: JS word boundaries are ASCII, so \bна\b never matches.
const AMOUNT_BETWEEN_V1 = String.raw`(?:\d+(?:[.,]\d+)?\s+)?`;
const DESTINATION_MARKER_V1 = new RegExp(
  String.raw`(?:^|[^\p{L}\p{N}])(?:to|into|for|в|на)\s+${AMOUNT_BETWEEN_V1}$|(?:->|=>|→)\s*$`,
  'iu',
);
const SOURCE_MARKER_V1 = new RegExp(
  String.raw`(?:^|[^\p{L}\p{N}])(?:from|из|с)\s+${AMOUNT_BETWEEN_V1}$`,
  'iu',
);

// "купи ETH за 100 USDC" and "how much ETH for 100 USDC" name the destination
// first: the asset behind the payment marker is the one that leaves the wallet.
// Only a buy-shaped sentence reverses the positional reading — "продай ETH за
// USDC" uses the same preposition for the opposite direction.
const BUY_SHAPED_V1 = /(?:^|[^\p{L}\p{N}])(?:buy|purchase|how\s+much)|(?:куп|приобрет|скольк)/iu;
const SELL_SHAPED_V1 = /(?:^|[^\p{L}\p{N}])sell|прода/iu;
const PAYMENT_MARKER_V1 = new RegExp(
  String.raw`(?:^|[^\p{L}\p{N}])(?:for|with|за|на)\s+${AMOUNT_BETWEEN_V1}$`,
  'iu',
);

function occurrenceDirectionV1(
  message: string,
  occurrence: AssetOccurrenceV1,
): 'source' | 'destination' | null {
  const before = message.slice(0, occurrence.index);
  if (DESTINATION_MARKER_V1.test(before)) return 'destination';
  if (SOURCE_MARKER_V1.test(before)) return 'source';
  return null;
}

function orderedAssetPairV1(
  message: string,
  occurrences: AssetOccurrenceV1[],
): [AssetOccurrenceV1, AssetOccurrenceV1] {
  const [first, second] = occurrences;
  const buyShaped = BUY_SHAPED_V1.test(message) && !SELL_SHAPED_V1.test(message);
  const paysWithSecond = PAYMENT_MARKER_V1.test(message.slice(0, second.index));
  return buyShaped && paysWithSecond ? [second, first] : [first, second];
}

/**
 * Whether the message itself names two different trusted assets. A verb that
 * usually means "move tokens somewhere" ("перевести", "transfer") means
 * "convert" when the sentence names both sides of a pair, so the unsupported
 * goal guard needs to see the pair before refusing.
 */
export function namesTrustedAssetPairV1(
  message: string,
  identified: IdentifiedAssetsV1 = [],
): boolean {
  return assetOccurrences(message, identified).length >= 2;
}

function rawFieldIsGrounded(raw: string, message: string): boolean {
  return normalizeText(message).includes(normalizeText(raw).trim());
}

function addressSafetyIssues(message: string, identified: IdentifiedAssetsV1 = []): IntentIssueV1[] {
  const tokens = message.match(/\b0x[0-9a-zA-Z]*/g) ?? [];
  // Known = pinned in the trusted table, OR read off its own contract for this
  // message. An address that answered `symbol()` and `decimals()` is a token
  // Miorail can name honestly; whether it may be TRADED is a separate verdict,
  // taken later by the token-security check and the Safety Kernel.
  const known = new Set([
    ...trustedBaseAssets().flatMap((asset) => (asset.address ? [asset.address.toLowerCase()] : [])),
    ...identified.flatMap((asset) => (asset.address ? [asset.address.toLowerCase()] : [])),
  ]);
  for (const token of tokens) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(token) || !known.has(token.toLowerCase())) {
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
  identified: IdentifiedAssetsV1,
): { fromAsset: AssetRefV1 | null; toAsset: AssetRefV1 | null; issues: IntentIssueV1[] } {
  const issues: IntentIssueV1[] = [...addressSafetyIssues(message, identified)];
  const occurrences = assetOccurrences(message, identified);

  const parseExtracted = (raw: string | null, field: 'fromAsset' | 'toAsset') => {
    if (!raw) return null;
    // Grounded by SPELLING, or failing that by the asset the spelling names.
    // "Хочу обменять 0.1 USDC на эфир" was rejected because the extractor
    // answered "ETH" for a message that says "эфир" — a correct normalisation,
    // read as an invention. The second check cannot invent anything: the asset
    // still has to be one the message itself names.
    const named = resolveRouteAssetV1(raw, identified);
    const groundedByAsset = Boolean(
      named && occurrences.some((occurrence) => occurrence.asset.assetId === named.assetId),
    );
    if (!rawFieldIsGrounded(raw, message) && !groundedByAsset) {
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
    const asset = resolveRouteAssetV1(raw, identified);
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
    const [orderedFrom, orderedTo] = orderedAssetPairV1(message, occurrences);
    if (
      (fromAsset && fromAsset.assetId !== orderedFrom.asset.assetId) ||
      (toAsset && toAsset.assetId !== orderedTo.asset.assetId)
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
      fromAsset = orderedFrom.asset;
      toAsset = orderedTo.asset;
    }
  } else if (occurrences.length === 1) {
    const only = occurrences[0];
    if (allowPending && pending?.fromAssetSymbol && !pending.toAssetSymbol) {
      const pendingFrom = resolveRouteAssetV1(pending.fromAssetSymbol, identified);
      if (pendingFrom?.assetId !== only.asset.assetId) toAsset ??= only.asset;
    } else if (allowPending && pending?.toAssetSymbol && !pending.fromAssetSymbol) {
      const pendingTo = resolveRouteAssetV1(pending.toAssetSymbol, identified);
      if (pendingTo?.assetId !== only.asset.assetId) fromAsset ??= only.asset;
    } else if (occurrenceDirectionV1(message, only) === 'destination') {
      if (fromAsset?.assetId !== only.asset.assetId) toAsset ??= only.asset;
    } else if (toAsset?.assetId !== only.asset.assetId) {
      // The default stays "the one named asset is the source", but it may never
      // fill a slot the other side already holds — that is how one named asset
      // became an invalid pair instead of a missing source.
      fromAsset ??= only.asset;
    }
  }

  if (allowPending) {
    fromAsset ??= resolveRouteAssetV1(pending?.fromAssetSymbol ?? null, identified);
    toAsset ??= resolveRouteAssetV1(pending?.toAssetSymbol ?? null, identified);
  }

  return { fromAsset, toAsset, issues };
}

export function mapOptimizationModeV1(message: string): {
  value: OptimizationModeV1;
  /** Whether the message ASKED for this mode. `best_net_result` is also the
   * default, so the value alone cannot tell a choice from a fallback — and a
   * follow-up turn must inherit only the choice. */
  stated: boolean;
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
      stated: false,
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
  return { value: unique[0] ?? 'best_net_result', stated: unique.length === 1, issues: [] };
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

/**
 * Three answers, not two. A message that says nothing about executing is not
 * the same as one that says "do not execute yet" — only the second is a choice
 * a follow-up turn should keep. `mapExecutionRequestedV1` collapses the pair
 * that a single request needs.
 */
export function executionIntentV1(message: string): 'execute' | 'quote_only' | null {
  const normalized = normalizeText(message);
  if (
    /\b(?:do not|don['’]?t|not)\s+(?:execute|trade|swap)\b|\bquote(?:-only)?\b|\bcompare routes?\b|не\s+(?:исполняй|выполняй|совершай)|только\s+котиров|сравни\w*\s+маршрут/iu.test(
      normalized,
    )
  ) {
    return 'quote_only';
  }
  if (
    /\b(?:prepare|swap|exchange|convert|buy|sell)\b|(?:подготов|обмен|поменя|свап|куп|прода|конверт|перевед)/iu.test(
      normalized,
    )
  ) {
    return 'execute';
  }
  return null;
}

export function mapExecutionRequestedV1(message: string): boolean {
  return executionIntentV1(message) === 'execute';
}

const OPTIMIZATION_MODES_V2: ReadonlyArray<OptimizationModeV1> = [
  'best_net_result',
  'lowest_fees',
  'lowest_risk',
  'fastest_execution',
  'simplest_route',
  'mev_protected',
];
const CONSTRAINABLE_PROTOCOLS_V2 = ['uniswap', 'kyberswap'] as const;

type ConstrainableProtocolV2 = (typeof CONSTRAINABLE_PROTOCOLS_V2)[number];

/** The wide route-intent constraint narrowed to what a later turn may inherit,
 * or null when there is nothing to inherit. `any` constrains nothing, and a
 * protocol outside the closed set is not something this engine can re-apply. */
function carriedProtocolConstraintV2(
  value: ProtocolConstraintV1,
): CarriedProtocolConstraintV2 | null {
  if (value.mode === 'any') return null;
  const protocols = value.protocols.filter((name): name is ConstrainableProtocolV2 =>
    (CONSTRAINABLE_PROTOCOLS_V2 as readonly string[]).includes(name),
  );
  if (protocols.length === 0 || protocols.length !== value.protocols.length) return null;
  return { mode: value.mode, protocols };
}

/**
 * A carried constraint is only ever something this engine wrote, so anything
 * that could not have come out of it is refused rather than repaired. The
 * values below decide what a later turn inherits, so accepting a shape the
 * engine never produces would mean inheriting a constraint no user stated.
 */
function carriedConstraintsAreValidV2(pending: CarriedSwapConstraintsV2): boolean {
  if (
    pending.optimizationMode !== null &&
    !OPTIMIZATION_MODES_V2.includes(pending.optimizationMode)
  ) {
    return false;
  }
  if (pending.verificationDepth !== null && !['enhanced', 'maximum'].includes(pending.verificationDepth)) {
    return false;
  }
  if (pending.executionRequested !== null && typeof pending.executionRequested !== 'boolean') {
    return false;
  }
  if (
    pending.slippageMaxBps !== null &&
    (!Number.isInteger(pending.slippageMaxBps) ||
      pending.slippageMaxBps < 0 ||
      pending.slippageMaxBps > 10_000)
  ) {
    return false;
  }
  const protocol = pending.protocolConstraint;
  if (protocol === null) return true;
  return (
    typeof protocol === 'object' &&
    // `any` is the absence of a constraint and is stored as null, so seeing it
    // here means the value did not come from this engine.
    (protocol.mode === 'include_only' || protocol.mode === 'exclude') &&
    Array.isArray(protocol.protocols) &&
    protocol.protocols.length > 0 &&
    protocol.protocols.every((name) =>
      (CONSTRAINABLE_PROTOCOLS_V2 as readonly string[]).includes(name),
    ) &&
    new Set(protocol.protocols).size === protocol.protocols.length
  );
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
      ![null, 'USDC', 'ETH', 'WETH'].includes(pending.toAssetSymbol) ||
      !carriedConstraintsAreValidV2(pending)
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

/** Amount and assets for one reading of the request — with a stored intent
 * available, or deliberately without one. Pure, so it can be run twice. */
function groundSwapCoreV2(
  input: { message: string; extraction: SwapIntentExtractionV2; identifiedAssets?: IdentifiedAssetsV1 },
  pending: PendingSwapIntentV2 | null,
): {
  amount: ReturnType<typeof normalizeExtractedAmount>;
  assets: ReturnType<typeof groundedAssets>;
  amountDecimal: string | null;
  fromAsset: AssetRefV1 | null;
  toAsset: AssetRefV1 | null;
  issues: IntentIssueV1[];
} {
  const amount = normalizeExtractedAmount(input.extraction, input.message, pending);
  const assets = groundedAssets(
    input.extraction,
    input.message,
    pending,
    !amount.conflictsPending,
    input.identifiedAssets ?? [],
  );
  return {
    amount,
    assets,
    amountDecimal: amount.value,
    fromAsset: assets.fromAsset,
    toAsset: assets.toAsset,
    issues: [...amount.issues, ...assets.issues],
  };
}

export function groundSwapFieldsV2(input: {
  message: string;
  extraction: SwapIntentExtractionV2;
  context: IntentRuntimeContextV2;
  walletAddress: string;
  /** Tokens read off their own contracts because the user named their
   * addresses in THIS message. Empty means the request named only assets this
   * repo already pins. */
  identifiedAssets?: IdentifiedAssetsV1;
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
  const stored = pendingCandidates.length === 1 ? pendingCandidates[0] : null;

  // A message that states the whole swap by itself is a NEW GOAL, not an answer
  // to an older question, so the stored intent is ignored rather than compared
  // against. Without this, "Swap 5 WETH to USDC" typed while an abandoned
  // "Swap 100 USDC" was still pending came back as "please restate one
  // unambiguous swap request" — the amounts differ because the goals differ.
  const alone = groundSwapCoreV2(input, null);
  const selfContained = Boolean(alone.amountDecimal && alone.fromAsset && alone.toAsset);
  const pending = selfContained ? null : stored;
  const core = selfContained ? alone : groundSwapCoreV2(input, pending);
  const amount = core.amount;
  const assets = core.assets;
  issues.push(...core.issues);
  const allowPending = !amount.conflictsPending;

  const optimization = mapOptimizationModeV1(input.message);
  const protocol = mapProtocolConstraintV1(input.message);
  const slippage = mapSlippageConstraintV1(input.message);
  issues.push(...optimization.issues, ...protocol.issues, ...slippage.issues);

  // Every constraint the user has ever stated in this exchange, with THIS turn
  // winning wherever it speaks. Without this, answering "ETH" to "which token
  // should be received?" silently dropped "1% slippage, only Uniswap" from the
  // turn before — the user would then approve a route they did not ask for.
  const verification = mapVerificationDepthV1(input.message);
  const execution = executionIntentV1(input.message);
  const inherited = allowPending ? pending : null;
  const carried: CarriedSwapConstraintsV2 = {
    optimizationMode: optimization.stated ? optimization.value : (inherited?.optimizationMode ?? null),
    verificationDepth:
      verification === 'standard' ? (inherited?.verificationDepth ?? null) : verification,
    protocolConstraint:
      carriedProtocolConstraintV2(protocol.value) ?? (inherited?.protocolConstraint ?? null),
    slippageMaxBps:
      slippage.value.source === 'user' ? slippage.value.maxBps : (inherited?.slippageMaxBps ?? null),
    executionRequested: execution === null ? (inherited?.executionRequested ?? null) : execution === 'execute',
  };

  return {
    amountDecimal: amount.value,
    fromAsset: assets.fromAsset,
    toAsset: assets.toAsset,
    optimizationMode: carried.optimizationMode ?? optimization.value,
    verificationDepth: carried.verificationDepth ?? 'standard',
    protocolConstraint: carried.protocolConstraint ?? protocol.value,
    slippageConstraint:
      carried.slippageMaxBps === null
        ? slippage.value
        : { maxBps: carried.slippageMaxBps, source: 'user' },
    executionRequested: carried.executionRequested ?? false,
    carried,
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
    // Carried verbatim: these are already "stated or inherited", never defaults.
    ...input.fields.carried,
  };
}
