import {
  CommerceRouteIntentV1Schema,
  hashCommerceRouteIntentV1,
  stableHashV1,
  type CommerceOptimizationModeV1,
  type CommerceProductKindV1,
  type CommerceRouteIntentV1,
  type HashV1,
} from '@mioagent/route-domain';
import { detectIntentLocaleV1, resolveRouteAssetV1 } from './normalization.js';
import type { IntentLocaleV1 } from './types.js';

// ---------------------------------------------------------------------------
// T64 — deterministic (no-LLM) EN/RU commerce intent extractor.
//
// Pure and offline, like the earn extractor. The one inference it makes — the
// market implied by an unambiguous currency — is DISCLOSED via
// `countryInferred`, so the surface can say "US market, inferred from the $
// price" instead of quietly buying for the wrong country. Everything else that
// is missing produces `needs_clarification`; nothing is invented.
// ---------------------------------------------------------------------------

const ZERO_HASH_V1 = `0x${'0'.repeat(64)}` as HashV1;

export type CommerceIntentIssueV1 =
  | 'not_commerce_goal'
  | 'product_required'
  | 'amount_required'
  | 'conflicting_amounts'
  | 'currency_ambiguous'
  | 'country_required'
  | 'kind_ambiguous'
  | 'recipient_required';

export interface CommerceIntentExtractionV1 {
  goal: 'commerce' | 'not_commerce';
  query: string | null;
  kind: CommerceProductKindV1;
  country: string | null;
  countryInferred: boolean;
  amountDecimal: string | null;
  currency: string | null;
  recipientInput: string | null;
  optimizationMode: CommerceOptimizationModeV1;
  executionRequested: boolean;
  locale: IntentLocaleV1;
  issues: CommerceIntentIssueV1[];
}

function normalize(message: string): string {
  return message.toLocaleLowerCase('en-US').replace(/ё/g, 'е');
}

/** `\b` is an ASCII word boundary and never matches before a Cyrillic letter,
 * so each family keeps an ASCII pattern and a separate Cyrillic one. */
const COMMERCE_EN_V1 = /\b(buy|purchase|gift\s?card|giftcard|top\s?up|topup|voucher|esim|bitrefill)\b/iu;
const COMMERCE_RU_V1 = /(купи|куплю|покупк|подароч|подарк|пополн|ваучер|есим)/iu;

export function detectCommerceGoalV1(message: string): boolean {
  const text = normalize(message);
  return COMMERCE_EN_V1.test(text) || COMMERCE_RU_V1.test(text);
}

const KIND_PATTERNS_V1: Array<[CommerceProductKindV1, RegExp]> = [
  ['esim', /\besim\b|\be-sim\b|есим|e-?сим/iu],
  ['topup', /\btop\s?up\b|\btopup\b|\brefill\b|\bmobile\s+credit\b|пополн\w*\s*(?:счет|баланс|телефон)?/iu],
  ['gift_card', /\bgift\s?card\b|\bgiftcard\b|\bvoucher\b|подароч\w*\s*карт\w*|подарочн\w*\s*сертификат/iu],
];

export function mapCommerceKindV1(message: string): { value: CommerceProductKindV1; ambiguous: boolean } {
  const text = normalize(message);
  const matched = KIND_PATTERNS_V1.filter(([, pattern]) => pattern.test(text)).map(([kind]) => kind);
  const unique = [...new Set(matched)];
  if (unique.length > 1) return { value: unique[0], ambiguous: true };
  // A bare "buy Steam $25" is a gift card in this family — that is the only
  // kind the deployment supports, and the validator refuses the others anyway.
  return { value: unique[0] ?? 'gift_card', ambiguous: false };
}

const CURRENCY_SYMBOLS_V1: Record<string, string> = {
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
};

const CURRENCY_WORDS_V1: Array<[string, RegExp]> = [
  ['USD', /\busd\b|\bdollars?\b|доллар\w*|бакс\w*/iu],
  ['EUR', /\beur\b|\beuros?\b|евро/iu],
  ['GBP', /\bgbp\b|\bpounds?\b|фунт\w*/iu],
];

/** Currencies whose market can be inferred without ambiguity within the
 * supported country set. `$` alone is USD here because CAD/AUD are always
 * written with their code in this vocabulary. */
const COUNTRY_BY_CURRENCY_V1: Record<string, string> = { USD: 'US', GBP: 'GB' };

const COUNTRY_PATTERNS_V1: Array<[string, RegExp]> = [
  ['US', /\b(?:us|usa|united\s+states)\b|сша|америк\w*/iu],
  ['GB', /\b(?:uk|gb|great\s+britain|united\s+kingdom)\b|британ\w*|англи\w*/iu],
  ['DE', /\b(?:de|germany)\b|герман\w*|немецк\w*/iu],
  ['FR', /\b(?:fr|france)\b|франц\w*/iu],
  ['IT', /\b(?:it|italy)\b|итал\w*/iu],
  ['ES', /\b(?:es|spain)\b|испан\w*/iu],
  ['NL', /\b(?:nl|netherlands)\b|нидерланд\w*|голланд\w*/iu],
  ['PL', /\b(?:pl|poland)\b|польш\w*|польск\w*/iu],
  ['CA', /\b(?:ca|canada)\b|канад\w*/iu],
  ['AU', /\b(?:au|australia)\b|австрал\w*/iu],
];

export function extractCommerceAmountV1(message: string): {
  amountDecimal: string | null;
  currency: string | null;
  conflicting: boolean;
  ambiguousCurrency: boolean;
} {
  const scrubbed = message.replace(/\b0x[0-9a-zA-Z]*/g, ' ');
  const amounts = new Set<string>();
  const currencies = new Set<string>();

  // "$25", "25$", "25 USD", "на 25 долларов" — the symbol may lead or trail.
  for (const match of scrubbed.matchAll(/([$€£])\s?(\d+(?:[.,]\d{1,2})?)/gu)) {
    amounts.add(match[2].replace(',', '.'));
    currencies.add(CURRENCY_SYMBOLS_V1[match[1]]);
  }
  for (const match of scrubbed.matchAll(/(\d+(?:[.,]\d{1,2})?)\s?([$€£])/gu)) {
    amounts.add(match[1].replace(',', '.'));
    currencies.add(CURRENCY_SYMBOLS_V1[match[2]]);
  }
  if (amounts.size === 0) {
    for (const match of scrubbed.matchAll(/\b(\d+(?:[.,]\d{1,2})?)\b/gu)) {
      const value = match[1].replace(',', '.');
      // Chain ids are not prices.
      if (value === '8453' || value === '84532') continue;
      amounts.add(value);
    }
  }
  for (const [code, pattern] of CURRENCY_WORDS_V1) {
    if (pattern.test(message)) currencies.add(code);
  }

  const amountList = [...amounts];
  const currencyList = [...currencies];
  return {
    amountDecimal: amountList.length === 1 ? amountList[0] : null,
    currency: currencyList.length === 1 ? currencyList[0] : null,
    conflicting: amountList.length > 1,
    ambiguousCurrency: currencyList.length > 1,
  };
}

export function mapCommerceCountryV1(message: string): string | null {
  const text = normalize(message);
  const matched = COUNTRY_PATTERNS_V1.filter(([, pattern]) => pattern.test(text)).map(([code]) => code);
  const unique = [...new Set(matched)];
  return unique.length === 1 ? unique[0] : null;
}

export function mapCommerceOptimizationModeV1(message: string): CommerceOptimizationModeV1 {
  const text = normalize(message);
  if (/\bcheapest\b|\blowest\s+(?:total|cost|price)\b|дешевл\w*|минимальн\w*\s+(?:цен|стоим)/iu.test(text)) {
    return 'lowest_total_cost';
  }
  if (/\bfastest\b|\bquickest\b|\basap\b|быстр\w*|срочн\w*/iu.test(text)) return 'fastest_delivery';
  return 'exact_denomination';
}

/** A phone number for a top-up. Only an explicit international number is
 * accepted — a bare digit run is a price, not a recipient. */
export function extractCommerceRecipientV1(message: string): string | null {
  const match = message.match(/\+\d[\d\s-]{6,18}\d/u);
  if (!match) return null;
  return match[0].replace(/[\s-]/g, '');
}

const NOISE_PATTERNS_V1: RegExp[] = [
  /\b(?:buy|purchase|get|order|please|for|me|a|an|the|on|with|using|worth|of)\b/giu,
  /(?:купи|куплю|купить|пожалуйста|мне|на|за|для|через)/giu,
  /\bgift\s?card\b|\bgiftcard\b|\bvoucher\b|\besim\b|\btop\s?up\b|\btopup\b|\brefill\b/giu,
  /подароч\w*|подарк\w*|сертификат\w*|ваучер\w*|пополн\w*|есим/giu,
  /[$€£]\s?\d+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?\s?[$€£]|\b\d+(?:[.,]\d{1,2})?\b/giu,
  /\busd\b|\beur\b|\bgbp\b|\bdollars?\b|\beuros?\b|\bpounds?\b/giu,
  /доллар\w*|евро|фунт\w*|бакс\w*/giu,
  /\+\d[\d\s-]{6,18}\d/gu,
];

/**
 * The brand the user named, recovered by removing everything the extractor has
 * already understood. Whatever survives IS the product query — the storefront
 * decides whether it matches anything, not this function.
 */
export function extractCommerceQueryV1(message: string): string | null {
  let remaining = message;
  for (const [, pattern] of COUNTRY_PATTERNS_V1) {
    remaining = remaining.replace(new RegExp(pattern.source, 'giu'), ' ');
  }
  for (const pattern of NOISE_PATTERNS_V1) remaining = remaining.replace(pattern, ' ');
  const words = remaining
    .replace(/[^\p{L}\p{N}\s.+-]/gu, ' ')
    .split(/\s+/u)
    .filter((word) => word.length > 1);
  if (words.length === 0) return null;
  const query = words.slice(0, 4).join(' ').trim();
  return query.length === 0 ? null : query.slice(0, 60);
}

export function extractCommerceIntentV1(message: string): CommerceIntentExtractionV1 {
  const locale = detectIntentLocaleV1(message);
  const issues: CommerceIntentIssueV1[] = [];
  const goal = detectCommerceGoalV1(message) ? 'commerce' : 'not_commerce';

  const kind = mapCommerceKindV1(message);
  if (kind.ambiguous) issues.push('kind_ambiguous');

  const amount = extractCommerceAmountV1(message);
  if (amount.conflicting) issues.push('conflicting_amounts');
  if (amount.ambiguousCurrency) issues.push('currency_ambiguous');

  const explicitCountry = mapCommerceCountryV1(message);
  const inferredCountry =
    explicitCountry === null && amount.currency !== null
      ? (COUNTRY_BY_CURRENCY_V1[amount.currency] ?? null)
      : null;
  const country = explicitCountry ?? inferredCountry;

  const recipientInput = extractCommerceRecipientV1(message);
  if (kind.value === 'topup' && recipientInput === null) issues.push('recipient_required');

  return {
    goal,
    query: extractCommerceQueryV1(message),
    kind: kind.value,
    country,
    countryInferred: explicitCountry === null && inferredCountry !== null,
    amountDecimal: amount.amountDecimal,
    currency: amount.currency,
    recipientInput,
    optimizationMode: mapCommerceOptimizationModeV1(message),
    executionRequested: false,
    locale,
    issues,
  };
}

export type CommerceIntentResolutionV1 =
  | { status: 'ready'; intent: CommerceRouteIntentV1; extraction: CommerceIntentExtractionV1; issues: [] }
  | { status: 'needs_clarification'; intent: null; extraction: CommerceIntentExtractionV1; issues: CommerceIntentIssueV1[] }
  | { status: 'unsupported'; intent: null; extraction: CommerceIntentExtractionV1; issues: CommerceIntentIssueV1[] };

export interface ResolveCommerceIntentInputV1 {
  message: string;
  tenantId: string;
  walletAddress: `0x${string}`;
  now: Date;
  /** Headroom over the requested value for provider fees, in basis points.
   * The ceiling is what the user is asked to authorize, so it is explicit
   * rather than derived from a quote that does not exist yet. */
  spendHeadroomBps?: number;
}

const DEFAULT_SPEND_HEADROOM_BPS_V1 = 1_500;

/**
 * Grounds an EN/RU commerce request into a validated CommerceRouteIntentV1.
 * Returns needs_clarification rather than inventing a product, a price, a
 * currency, or a recipient.
 */
export function resolveCommerceIntentV1(
  input: ResolveCommerceIntentInputV1,
): CommerceIntentResolutionV1 {
  const extraction = extractCommerceIntentV1(input.message);
  if (extraction.goal !== 'commerce') {
    return { status: 'unsupported', intent: null, extraction, issues: ['not_commerce_goal', ...extraction.issues] };
  }

  const blocking = extraction.issues.filter(
    (code) => code === 'conflicting_amounts' || code === 'currency_ambiguous' || code === 'kind_ambiguous' || code === 'recipient_required',
  );
  const missing: CommerceIntentIssueV1[] = [];
  if (extraction.query === null) missing.push('product_required');
  if (extraction.amountDecimal === null) missing.push('amount_required');
  if (extraction.currency === null) missing.push('currency_ambiguous');
  if (extraction.country === null) missing.push('country_required');
  if (blocking.length > 0 || missing.length > 0) {
    return {
      status: 'needs_clarification',
      intent: null,
      extraction,
      issues: [...new Set([...extraction.issues, ...missing])],
    };
  }

  const usdc = resolveRouteAssetV1('USDC');
  if (!usdc) {
    return { status: 'unsupported', intent: null, extraction, issues: [...extraction.issues] };
  }

  const requestedDecimal = extraction.amountDecimal as string;
  const [whole, fraction = ''] = requestedDecimal.split('.');
  const requestedMinor = BigInt(`${whole}${fraction.padEnd(2, '0').slice(0, 2)}`);
  const headroomBps = BigInt(input.spendHeadroomBps ?? DEFAULT_SPEND_HEADROOM_BPS_V1);
  // minor units (1e-2) → USDC base units (1e-6), then the authorized headroom.
  const requestedAtomic = requestedMinor * BigInt(10_000);
  const maxSpendAtomic = (requestedAtomic * (BigInt(10_000) + headroomBps)) / BigInt(10_000);

  const nowIso = input.now.toISOString();
  const draft = {
    schemaVersion: 'commerce-route-intent/v1' as const,
    id: `commerce-intent:${stableHashV1('commerce-intent', {
      tenantId: input.tenantId,
      walletAddress: input.walletAddress.toLowerCase(),
      query: extraction.query,
      kind: extraction.kind,
      country: extraction.country,
      amountDecimal: requestedDecimal,
      currency: extraction.currency,
    }).slice(2, 26)}`,
    tenantId: input.tenantId,
    walletAddress: input.walletAddress,
    chainId: 8453 as const,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: 'ready' as const,
    intentHash: ZERO_HASH_V1,
    goal: 'commerce' as const,
    query: extraction.query as string,
    kind: extraction.kind,
    country: extraction.country as string,
    requestedValue: { amountDecimal: requestedDecimal, currency: extraction.currency as string },
    paymentAsset: usdc,
    maxSpendAtomic: maxSpendAtomic.toString(),
    recipientInput: extraction.recipientInput,
    optimizationMode: extraction.optimizationMode,
    executionRequested: extraction.executionRequested,
  };
  const intent = CommerceRouteIntentV1Schema.parse({
    ...draft,
    intentHash: hashCommerceRouteIntentV1(draft as unknown as CommerceRouteIntentV1),
  });
  return { status: 'ready', intent, extraction, issues: [] };
}
