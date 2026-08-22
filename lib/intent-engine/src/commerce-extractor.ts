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
  | 'conflicting_limits'
  | 'limit_currency_unsupported'
  | 'limit_below_denomination'
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
  /** T64.3.1: the FACE VALUE of the product — "$5 Steam card" → "5". */
  denominationDecimal: string | null;
  currency: string | null;
  /** T64.3.1: the SPENDING CEILING the user stated — "never spend more than
   * 6 USDC" → "6". A separate number with a separate meaning; merging the two
   * is what made a perfectly clear sentence read as `conflicting_amounts`. */
  maxSpendDecimal: string | null;
  maxSpendCurrency: string | null;
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
// A purchase verb is not a commerce product. "Buy BRETT with USDC" is a swap;
// commerce requires a gift-card/top-up/eSIM/Bitrefill noun.
const COMMERCE_EN_V1 = /\b(gift\s?cards?|giftcards?|top\s?up|topup|voucher|esim|bitrefill)\b|\b(?:buy|purchase|get|find|order)\b.{0,48}\bcards?\b/iu;
const COMMERCE_RU_V1 = /(подароч|подарк|сертификат|пополн|ваучер|есим)/iu;

export function detectCommerceGoalV1(message: string): boolean {
  const text = normalize(message);
  return COMMERCE_EN_V1.test(text) || COMMERCE_RU_V1.test(text);
}

const KIND_PATTERNS_V1: Array<[CommerceProductKindV1, RegExp]> = [
  ['esim', /\besim\b|\be-sim\b|есим|e-?сим/iu],
  ['topup', /\btop\s?up\b|\btopup\b|\brefill\b|\bmobile\s+credit\b|пополн\p{L}*\s*(?:счет|баланс|телефон)?/iu],
  ['gift_card', /\bgift\s?card\b|\bgiftcard\b|\bvoucher\b|подароч\p{L}*\s*карт\p{L}*|подарочн\p{L}*\s*сертификат/iu],
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
  ['USD', /\busd\b|\bdollars?\b|доллар\p{L}*|бакс\p{L}*/iu],
  ['EUR', /\beur\b|\beuros?\b|евро/iu],
  ['GBP', /\bgbp\b|\bpounds?\b|фунт\p{L}*/iu],
];

/** Currencies whose market can be inferred without ambiguity within the
 * supported country set. `$` alone is USD here because CAD/AUD are always
 * written with their code in this vocabulary. */
const COUNTRY_BY_CURRENCY_V1: Record<string, string> = { USD: 'US', GBP: 'GB' };

const COUNTRY_PATTERNS_V1: Array<[string, RegExp]> = [
  ['US', /\b(?:us|usa|united\s+states)\b|сша|америк\p{L}*/iu],
  ['GB', /\b(?:uk|gb|great\s+britain|united\s+kingdom)\b|британ\p{L}*|англи\p{L}*/iu],
  ['DE', /\b(?:de|germany)\b|герман\p{L}*|немецк\p{L}*/iu],
  ['FR', /\b(?:fr|france)\b|франц\p{L}*/iu],
  ['IT', /\b(?:it|italy)\b|итал\p{L}*/iu],
  ['ES', /\b(?:es|spain)\b|испан\p{L}*/iu],
  ['NL', /\b(?:nl|netherlands)\b|нидерланд\p{L}*|голланд\p{L}*/iu],
  ['PL', /\b(?:pl|poland)\b|польш\p{L}*|польск\p{L}*/iu],
  ['CA', /\b(?:ca|canada)\b|канад\p{L}*/iu],
  ['AU', /\b(?:au|australia)\b|австрал\p{L}*/iu],
];

// --- T64.3.1: spending ceilings are not prices ------------------------------
//
// "Buy a $5 Steam card. Never spend more than 6 USDC." states TWO numbers with
// two different jobs: a denomination to order and a ceiling to authorize. The
// first extractor treated every number in the sentence as a candidate price and
// refused the whole goal as `conflicting_amounts`. The ceiling clause is now
// lifted out FIRST, so the amount extractor only ever sees the denomination.

/** Lead-ins that introduce a ceiling. Deliberately does NOT include "up to" —
 * "top up to 5 USD" would have read a top-up amount as a limit. */
const SPEND_LIMIT_LEAD_V1 = String.raw`(?:never\s+spend\s+(?:more\s+than|over|above)|do(?:n'?t|\s+not)\s+spend\s+(?:more\s+than|over|above)|spend(?:ing)?\s+limit(?:\s+of)?|no\s+more\s+than|not\s+more\s+than|at\s+most|max(?:imum)?(?:\s+of)?|ceiling(?:\s+of)?|budget(?:\s+of)?|не\s+тратить\s+больше|не\s+больше|не\s+более|не\s+дороже|максимальн\p{L}*|максимум|лимит\p{L}*)`;

/** The lead-in plus the number it governs, and the currency if one was named.
 * `(?<!\p{L})` replaces `\b`, which never matches before a Cyrillic letter. */
const SPEND_LIMIT_CLAUSE_V1 = new RegExp(
  String.raw`(?<!\p{L})${SPEND_LIMIT_LEAD_V1}[\s:=~-]*(?:of\s+)?([$€£])?\s?(\d+(?:[.,]\d{1,2})?)\s*([$€£])?\s*(usdc|usdt|usd|dollars?|eur|euros?|gbp|pounds?|доллар\p{L}*|евро|фунт\p{L}*|бакс\p{L}*)?`,
  'giu',
);

function limitCurrencyV1(symbol: string | undefined, word: string | undefined): string | null {
  if (symbol) return CURRENCY_SYMBOLS_V1[symbol] ?? null;
  if (!word) return null;
  const text = word.toLocaleLowerCase('en-US');
  if (text.startsWith('usdc')) return 'USDC';
  if (text.startsWith('usdt')) return 'USDT';
  if (text.startsWith('usd') || text.startsWith('dollar') || text.startsWith('доллар') || text.startsWith('бакс')) {
    return 'USD';
  }
  if (text.startsWith('eur') || text === 'евро') return 'EUR';
  if (text.startsWith('gbp') || text.startsWith('pound') || text.startsWith('фунт')) return 'GBP';
  return null;
}

export interface CommerceSpendLimitV1 {
  maxSpendDecimal: string | null;
  currency: string | null;
  /** The message with every ceiling clause cut out. Everything downstream —
   * the denomination, the currency, the product query — reads THIS. */
  remainder: string;
  /** Two different ceilings were stated; neither is assumed. */
  conflicting: boolean;
}

export function extractCommerceSpendLimitV1(message: string): CommerceSpendLimitV1 {
  const values = new Set<string>();
  const currencies = new Set<string>();
  let remainder = '';
  let cursor = 0;
  for (const match of message.matchAll(SPEND_LIMIT_CLAUSE_V1)) {
    values.add(match[2].replace(',', '.'));
    const currency = limitCurrencyV1(match[1] ?? match[3], match[4]);
    if (currency) currencies.add(currency);
    remainder += message.slice(cursor, match.index);
    cursor = (match.index ?? 0) + match[0].length;
  }
  remainder += message.slice(cursor);
  const values_ = [...values];
  const currencies_ = [...currencies];
  return {
    maxSpendDecimal: values_.length === 1 ? values_[0] : null,
    currency: currencies_.length === 1 ? currencies_[0] : null,
    remainder,
    conflicting: values_.length > 1,
  };
}

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
  if (/\bcheapest\b|\blowest\s+(?:total|cost|price)\b|дешевл\p{L}*|минимальн\p{L}*\s+(?:цен|стоим)/iu.test(text)) {
    return 'lowest_total_cost';
  }
  if (/\bfastest\b|\bquickest\b|\basap\b|быстр\p{L}*|срочн\p{L}*/iu.test(text)) return 'fastest_delivery';
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
  /\b(?:buy|purchase|get|find|order|please|for|me|a|an|the|on|with|using|worth|of|bitrefill)\b/giu,
  /(?:купи|куплю|купить|пожалуйста|мне|на|за|для|через)/giu,
  // Plurals included: `\bgift\s?card\b` does not match "gift cards", which
  // left a bare "gift" behind and sent it to the storefront as the brand.
  /\bgift\s?cards?\b|\bgiftcards?\b|\bvouchers?\b|\besims?\b|\btop\s?ups?\b|\btopups?\b|\brefills?\b/giu,
  /подароч\p{L}*|подарк\p{L}*|сертификат\p{L}*|ваучер\p{L}*|пополн\p{L}*|есим/giu,
  /[$€£]\s?\d+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?\s?[$€£]|\b\d+(?:[.,]\d{1,2})?\b/giu,
  /\busdc?\b|\busdt\b|\beur\b|\bgbp\b|\bdollars?\b|\beuros?\b|\bpounds?\b/giu,
  /доллар\p{L}*|евро|фунт\p{L}*|бакс\p{L}*/giu,
  /\+\d[\d\s-]{6,18}\d/gu,
  // T64.3.1 — ceiling vocabulary. The clause WITH its number is removed before
  // this list runs; these catch the leftovers ("no limit", "spend less").
  /\b(?:never|do\s+not|don'?t|spend|spending|more|less|than|most|max|maximum|minimum|limit|cap|budget|ceiling|total|only|just|card|cards)\b/giu,
  /(?:не\s+больше|не\s+более|не\s+дороже|максимальн\p{L}*|максимум|лимит\p{L}*|потрат\p{L}*|карт\p{L}*|тольк\p{L}*)/giu,
];

/**
 * Words that belong to the INTERFACE, never to a product.
 *
 * The query is built by subtraction — whatever survives the noise filters is
 * treated as the brand. That is fine while the user names a product, and it
 * fails loudly when they do not: "Browse Bitrefill gift cards available in the
 * United States" left `Browse gift available in`, which was then sent to
 * Bitrefill's catalogue as a search term. The storefront dutifully found no
 * product called "Browse gift available in" and Miorail reported that as
 * Bitrefill having nothing for the US.
 *
 * So the vocabulary of asking is separated from the vocabulary of buying. A
 * word here can never reach a provider query, in any language. This list is
 * about grammar, not about products: no brand is excluded by it.
 */
const INTERFACE_WORDS_V1: RegExp[] = [
  /\b(?:browse|show|list|display|search|see|view|look|looking|available|availability|options?|catalogue|catalog|selection|which|what|whats|what's|any|all|some|are|is|there|here|in|at|to|from|by|and|or|but|near|around|within|via|about|my|your|their|its|it|they|we|you|i)\b/giu,
  /(?:покажи|показать|посмотр|смотр|список|перечень|выбор|каталог|доступн|какие|какой|что|есть|можно|мне|мой|моя|мои|там|тут|около|через|про|и|или)/giu,
];

/**
 * Does the message name a product at all, or is it a request to see what is
 * available? A broad browse is a legitimate intent with `query === null`; the
 * caller decides what to do with it and must not search for the words the user
 * used to ask the question.
 */
export function isBroadCatalogueBrowseV1(message: string): boolean {
  return extractCommerceQueryV1(message) === null;
}

/**
 * The brand the user named, recovered by removing everything the extractor has
 * already understood — including the interface vocabulary above. Whatever
 * survives IS the product query; when nothing survives, the answer is `null`
 * (a browse), never the leftovers of the sentence.
 */
export function extractCommerceQueryV1(message: string): string | null {
  // T64.3.1 — the ceiling clause leaves FIRST. Without this, "never spend more
  // than 6 USDC" was searched for at the storefront as part of the brand.
  let remaining = message.replace(SPEND_LIMIT_CLAUSE_V1, ' ');
  for (const [, pattern] of COUNTRY_PATTERNS_V1) {
    remaining = remaining.replace(new RegExp(pattern.source, 'giu'), ' ');
  }
  for (const pattern of NOISE_PATTERNS_V1) remaining = remaining.replace(pattern, ' ');
  // Last, so a brand containing an ordinary word ("Just Eat") has already been
  // protected by the more specific filters above.
  for (const pattern of INTERFACE_WORDS_V1) remaining = remaining.replace(pattern, ' ');
  const words = remaining
    .replace(/[^\p{L}\p{N}\s.+-]/gu, ' ')
    .split(/\s+/u)
    // A brand may legitimately contain a dot ("Amazon.com"); sentence
    // punctuation around it may not.
    .map((word) => word.replace(/^[.+-]+/u, '').replace(/[.+-]+$/u, ''))
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

  // The ceiling is lifted out before the denomination is read, so a sentence
  // that names both is understood instead of refused.
  const limit = extractCommerceSpendLimitV1(message);
  if (limit.conflicting) issues.push('conflicting_limits');
  // The rail settles in USDC. A ceiling stated in EUR or GBP is a currency
  // conversion this extractor will not perform silently.
  if (limit.maxSpendDecimal !== null && limit.currency !== null && limit.currency !== 'USD' && limit.currency !== 'USDC') {
    issues.push('limit_currency_unsupported');
  }

  const amount = extractCommerceAmountV1(limit.remainder);
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
    denominationDecimal: amount.amountDecimal,
    currency: amount.currency,
    maxSpendDecimal: limit.maxSpendDecimal,
    maxSpendCurrency: limit.currency,
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
  /**
   * The caller's request id, folded into the intent id exactly as the swap
   * resolver does.
   *
   * Without it the id was derived from the GOAL TEXT alone while the intent
   * hash covered `createdAt`. Comparing the same gift card twice then found
   * its own earlier run under the same id, saw a different hash, and raised a
   * content conflict — so a repeated Commerce goal failed permanently. Two
   * comparisons of one goal are two comparisons: catalogues and prices move
   * between them, and each deserves its own run.
   */
  requestId?: string;
}

const DEFAULT_SPEND_HEADROOM_BPS_V1 = 1_500;

/** A decimal string → USDC base units (1e-6). The extractor only ever produces
 * at most two fraction digits, so this is exact rather than rounded. */
function usdcAtomicFromDecimalV1(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(`${whole}${fraction.padEnd(6, '0').slice(0, 6)}`);
}

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
    (code) =>
      code === 'conflicting_amounts' ||
      code === 'conflicting_limits' ||
      code === 'limit_currency_unsupported' ||
      code === 'currency_ambiguous' ||
      code === 'kind_ambiguous' ||
      code === 'recipient_required',
  );
  const missing: CommerceIntentIssueV1[] = [];
  if (extraction.query === null) missing.push('product_required');
  if (extraction.denominationDecimal === null) missing.push('amount_required');
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

  const requestedDecimal = extraction.denominationDecimal as string;
  const requestedAtomic = usdcAtomicFromDecimalV1(requestedDecimal);
  const headroomBps = BigInt(input.spendHeadroomBps ?? DEFAULT_SPEND_HEADROOM_BPS_V1);
  const derivedCeiling = (requestedAtomic * (BigInt(10_000) + headroomBps)) / BigInt(10_000);
  // T64.3.1 — an explicit ceiling REPLACES the derived headroom. The user said
  // a number; authorizing more than it because a formula produced more would be
  // the whole point of the sentence, ignored.
  const statedCeiling = extraction.maxSpendDecimal === null ? null : usdcAtomicFromDecimalV1(extraction.maxSpendDecimal);
  const maxSpendAtomic = statedCeiling ?? derivedCeiling;

  // A ceiling below the face value cannot buy the card. Only checked when the
  // denomination is itself USD/USDC — comparing 5 EUR to 6 USDC would be an fx
  // assumption, and the ceiling still applies as an absolute cap either way.
  const denominationIsSettlementCurrency = extraction.currency === 'USD';
  if (statedCeiling !== null && denominationIsSettlementCurrency && statedCeiling < requestedAtomic) {
    return {
      status: 'needs_clarification',
      intent: null,
      extraction,
      issues: [...new Set([...extraction.issues, 'limit_below_denomination' as const])],
    };
  }

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
      // Omitted when absent so existing content-addressed ids are unchanged.
      ...(input.requestId ? { requestId: input.requestId } : {}),
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
