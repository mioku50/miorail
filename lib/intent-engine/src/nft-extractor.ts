import {
  NftPurchaseIntentV1Schema,
  hashNftPurchaseIntentV1,
  stableHashV1,
  type HashV1,
  type NftIntentSourceV1,
  type NftPurchaseIntentV1,
  type NftVerificationDepthV1,
} from '@mioagent/route-domain';
import { detectIntentLocaleV1 } from './normalization.js';
import type { IntentLocaleV1 } from './types.js';

// ---------------------------------------------------------------------------
// T65 §2 — deterministic (no-LLM) EN/RU NFT purchase intent extractor.
//
// Three ways to name one token, and they are NOT equally strong:
//
//   contract + tokenId  — unambiguous. This IS the identity.
//   opensea URL         — unambiguous when it carries chain/contract/tokenId.
//   slug + tokenId      — a HINT. A slug can be reassigned and is not identity,
//                         so it is carried forward for lookup and the resolved
//                         contract is what gets verified.
//
// Nothing is inferred. An NFT with no stated ceiling produces a clarification
// rather than an unbounded purchase, because "buy this NFT" with no price is
// the one instruction this family must never execute on its own reading.
// ---------------------------------------------------------------------------

const ZERO_HASH_V1 = `0x${'0'.repeat(64)}` as HashV1;

export type NftIntentIssueV1 =
  | 'not_nft_goal'
  | 'token_required'
  | 'collection_required'
  | 'ambiguous_token'
  | 'chain_unsupported'
  | 'standard_unsupported'
  | 'max_spend_required'
  | 'conflicting_limits'
  | 'limit_currency_unsupported';

export interface NftIntentExtractionV1 {
  goal: 'nft_purchase' | 'not_nft';
  inputSource: NftIntentSourceV1 | null;
  collectionSlug: string | null;
  contractAddress: string | null;
  tokenId: string | null;
  /** The chain named by a URL, before it is checked. `null` when none was
   * stated; a non-Base value becomes `chain_unsupported` rather than being
   * quietly treated as Base. */
  chainSlug: string | null;
  maxSpendDecimal: string | null;
  maxSpendCurrency: string | null;
  verificationDepth: NftVerificationDepthV1;
  locale: IntentLocaleV1;
  issues: NftIntentIssueV1[];
}

function normalize(message: string): string {
  return message.toLocaleLowerCase('en-US').replace(/ё/g, 'е');
}

const NFT_EN_V1 = /\b(nft|opensea|token\s?id|collectible)\b/iu;
const NFT_RU_V1 = /(нфт|нфти|опенси|опенсиа|коллекционн)/iu;
const BUY_EN_V1 = /\b(buy|purchase|get|acquire|snag)\b/iu;
const BUY_RU_V1 = /(купи|куплю|купить|приобрет)/iu;

/** opensea.io paths that carry a full identity. Both the historical
 * `/assets/<chain>/<contract>/<id>` and the current `/item/...` shape. */
const OPENSEA_ITEM_URL_V1 =
  /https?:\/\/(?:www\.)?opensea\.io\/(?:assets|item)\/([a-z0-9_-]+)\/(0x[0-9a-fA-F]{40})\/(\d{1,78})/iu;
/** A collection URL carries a slug and no token — a clarification, not a buy. */
const OPENSEA_COLLECTION_URL_V1 = /https?:\/\/(?:www\.)?opensea\.io\/collection\/([a-z0-9_-]+)/iu;

const BARE_CONTRACT_V1 = /(?<![0-9a-fA-F])(0x[0-9a-fA-F]{40})(?![0-9a-fA-F])/u;
/** "#123" or "token id 123" or "токен 123". A bare number is a price far more
 * often than a token id, so it never counts on its own. */
const TOKEN_ID_V1 = /#\s?(\d{1,78})|(?:token\s?(?:id)?|tokenid|токен\w*)\s*[#:]?\s*(\d{1,78})/iu;

export function detectNftGoalV1(message: string): boolean {
  const text = normalize(message);
  if (OPENSEA_ITEM_URL_V1.test(message) || OPENSEA_COLLECTION_URL_V1.test(message)) return true;
  const named = NFT_EN_V1.test(text) || NFT_RU_V1.test(text);
  const wants = BUY_EN_V1.test(text) || BUY_RU_V1.test(text);
  // "buy … #123" reads as an NFT even without the word: a hash-number token
  // reference has no other meaning in this product.
  return (named && wants) || (wants && /#\s?\d{1,78}/u.test(message)) || named;
}

// --- Spend ceiling ----------------------------------------------------------
//
// Same discipline as the Commerce family: the ceiling clause is lifted out of
// the sentence first, so it can never be mistaken for a token id or a price.

const CEILING_LEAD_V1 = String.raw`(?:cheaper\s+than|less\s+than|under|below|no\s+more\s+than|not\s+more\s+than|at\s+most|max(?:imum)?(?:\s+of)?|budget(?:\s+of)?|never\s+spend\s+more\s+than|spend(?:ing)?\s+limit(?:\s+of)?|дешевле|не\s+дороже|не\s+больше|не\s+более|максимум|максимальн\p{L}*|лимит\p{L}*|до)`;

const CEILING_CLAUSE_V1 = new RegExp(
  String.raw`(?<!\p{L})${CEILING_LEAD_V1}[\s:=~-]*(?:of\s+)?(\d+(?:[.,]\d{1,18})?)\s*(eth|weth|усd|usdc|usdt|эфир\p{L}*|eth\p{L}*)?`,
  'giu',
);

function ceilingCurrencyV1(word: string | undefined): string | null {
  if (!word) return null;
  const text = word.toLocaleLowerCase('en-US');
  if (text.startsWith('weth')) return 'WETH';
  if (text.startsWith('eth') || text.startsWith('эфир')) return 'ETH';
  if (text.startsWith('usd')) return 'USD';
  return null;
}

export interface NftSpendCeilingV1 {
  maxSpendDecimal: string | null;
  currency: string | null;
  /** The message with every ceiling clause cut out — what the token parsers
   * read, so "cheaper than 0.02 ETH" can never supply a token id. */
  remainder: string;
  conflicting: boolean;
}

export function extractNftSpendCeilingV1(message: string): NftSpendCeilingV1 {
  const values = new Set<string>();
  const currencies = new Set<string>();
  let remainder = '';
  let cursor = 0;
  for (const match of message.matchAll(CEILING_CLAUSE_V1)) {
    values.add(match[1].replace(',', '.'));
    const currency = ceilingCurrencyV1(match[2]);
    if (currency) currencies.add(currency);
    remainder += message.slice(cursor, match.index);
    cursor = (match.index ?? 0) + match[0].length;
  }
  remainder += message.slice(cursor);
  const valueList = [...values];
  const currencyList = [...currencies];
  return {
    maxSpendDecimal: valueList.length === 1 ? valueList[0] : null,
    currency: currencyList.length === 1 ? currencyList[0] : null,
    remainder,
    conflicting: valueList.length > 1,
  };
}

/** An ETH decimal string → wei. Exact: the digits are placed, never scaled
 * through a float. */
export function ethDecimalToWeiV1(value: string): string | null {
  if (!/^\d+(\.\d{1,18})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(`${whole}${fraction.padEnd(18, '0')}`).toString();
}

// --- Token identity ---------------------------------------------------------

/** Slug candidates are the words the user typed that are not noise. Kept to
 * one token so a two-word collection name still resolves. */
const SLUG_NOISE_V1: RegExp[] = [
  /\b(?:buy|purchase|get|acquire|the|a|an|for|me|please|nft|token\s?id|tokenid|token|collectible|on|from|opensea|base|mainnet|eth|weth|item|listing)\b/giu,
  /(?:купи|куплю|купить|приобрет\p{L}*|пожалуйста|мне|нфт\p{L}*|токен\p{L}*|опенси\p{L}*|базе|база|эфир\p{L}*|лот)/giu,
  /https?:\/\/\S+/giu,
  /0x[0-9a-fA-F]{40}/giu,
  /#\s?\d{1,78}/giu,
  /\b\d+(?:[.,]\d+)?\b/giu,
];

export function extractNftCollectionSlugV1(message: string): string | null {
  let remaining = message.replace(CEILING_CLAUSE_V1, ' ');
  for (const pattern of SLUG_NOISE_V1) remaining = remaining.replace(pattern, ' ');
  const words = remaining
    .replace(/[^\p{L}\p{N}\s.-]/gu, ' ')
    .split(/\s+/u)
    .map((word) => word.replace(/^[.-]+/u, '').replace(/[.-]+$/u, ''))
    .filter((word) => word.length > 1);
  if (words.length === 0) return null;
  return words.slice(0, 3).join('-').toLocaleLowerCase('en-US').slice(0, 200);
}

export function extractNftIntentV1(message: string): NftIntentExtractionV1 {
  const locale = detectIntentLocaleV1(message);
  const issues: NftIntentIssueV1[] = [];
  const goal = detectNftGoalV1(message) ? 'nft_purchase' : 'not_nft';

  const ceiling = extractNftSpendCeilingV1(message);
  if (ceiling.conflicting) issues.push('conflicting_limits');
  // V1 pays in native ETH. A ceiling in WETH or dollars is a conversion this
  // extractor will not perform silently.
  if (ceiling.maxSpendDecimal !== null && ceiling.currency !== null && ceiling.currency !== 'ETH') {
    issues.push('limit_currency_unsupported');
  }

  const itemUrl = OPENSEA_ITEM_URL_V1.exec(message);
  const collectionUrl = OPENSEA_COLLECTION_URL_V1.exec(message);
  const tokenMatch = TOKEN_ID_V1.exec(ceiling.remainder);
  const tokenFromText = tokenMatch ? (tokenMatch[1] ?? tokenMatch[2] ?? null) : null;
  const contractFromText = BARE_CONTRACT_V1.exec(ceiling.remainder)?.[1] ?? null;

  let inputSource: NftIntentSourceV1 | null;
  let chainSlug: string | null = null;
  let contractAddress: string | null = null;
  let tokenId: string | null;
  let collectionSlug: string | null = null;

  if (itemUrl) {
    inputSource = 'opensea_url';
    chainSlug = itemUrl[1].toLocaleLowerCase('en-US');
    contractAddress = itemUrl[2].toLocaleLowerCase('en-US');
    tokenId = itemUrl[3];
    // A URL that says another chain is REFUSED by value. Treating it as Base
    // would buy a different token on a different network.
    if (chainSlug !== 'base') issues.push('chain_unsupported');
    // A token named twice, differently, is not a token this can act on.
    if (tokenFromText !== null && tokenFromText !== tokenId) issues.push('ambiguous_token');
    if (contractFromText !== null && contractFromText !== contractAddress) issues.push('ambiguous_token');
  } else if (contractFromText !== null) {
    inputSource = 'contract_and_token';
    contractAddress = contractFromText;
    tokenId = tokenFromText;
    collectionSlug = collectionUrl ? collectionUrl[1].toLocaleLowerCase('en-US') : null;
  } else {
    inputSource = 'slug_and_token';
    collectionSlug = collectionUrl
      ? collectionUrl[1].toLocaleLowerCase('en-US')
      : extractNftCollectionSlugV1(message);
    tokenId = tokenFromText;
  }

  if (tokenId === null) issues.push('token_required');
  if (contractAddress === null && collectionSlug === null) issues.push('collection_required');

  return {
    goal,
    inputSource,
    collectionSlug,
    contractAddress,
    tokenId,
    chainSlug,
    maxSpendDecimal: ceiling.maxSpendDecimal,
    maxSpendCurrency: ceiling.currency,
    // `deep` is opt-in; nothing about a plain purchase request implies the
    // caller wants extra paid verification.
    verificationDepth: /\bdeep\b|тщательн\p{L}*|глубок\p{L}*/iu.test(message) ? 'deep' : 'standard',
    locale,
    issues,
  };
}

export type NftIntentResolutionV1 =
  | { status: 'ready'; intent: NftPurchaseIntentV1; extraction: NftIntentExtractionV1; issues: [] }
  | { status: 'needs_clarification'; intent: null; extraction: NftIntentExtractionV1; issues: NftIntentIssueV1[] }
  | { status: 'unsupported'; intent: null; extraction: NftIntentExtractionV1; issues: NftIntentIssueV1[] };

export interface ResolveNftIntentInputV1 {
  message: string;
  tenantId: string;
  walletAddress: `0x${string}`;
  now: Date;
  /** Folded into the intent id so each comparison is its own run. Two looks at
   * one listing are two looks: listings get cancelled and filled between them. */
  requestId?: string;
}

/**
 * Grounds an EN/RU NFT request into a validated NftPurchaseIntentV1.
 *
 * Returns needs_clarification rather than inventing a token, a collection, or
 * — most importantly — a spending ceiling.
 */
export function resolveNftIntentV1(input: ResolveNftIntentInputV1): NftIntentResolutionV1 {
  const extraction = extractNftIntentV1(input.message);
  if (extraction.goal !== 'nft_purchase') {
    return { status: 'unsupported', intent: null, extraction, issues: ['not_nft_goal', ...extraction.issues] };
  }
  // A chain the deployment does not route on is unsupported, not a question.
  if (extraction.issues.includes('chain_unsupported')) {
    return { status: 'unsupported', intent: null, extraction, issues: [...extraction.issues] };
  }

  const missing: NftIntentIssueV1[] = [];
  // An unbounded NFT purchase is never assumed. This is the single most
  // consequential clarification in the family.
  if (extraction.maxSpendDecimal === null) missing.push('max_spend_required');
  const blocking = extraction.issues.filter(
    (code) => code === 'ambiguous_token' || code === 'conflicting_limits' || code === 'limit_currency_unsupported',
  );
  if (blocking.length > 0 || missing.length > 0 || extraction.tokenId === null) {
    return {
      status: 'needs_clarification',
      intent: null,
      extraction,
      issues: [...new Set([...extraction.issues, ...missing])],
    };
  }

  const maxSpendWei = ethDecimalToWeiV1(extraction.maxSpendDecimal as string);
  if (maxSpendWei === null || BigInt(maxSpendWei) <= BigInt(0)) {
    return {
      status: 'needs_clarification',
      intent: null,
      extraction,
      issues: [...new Set([...extraction.issues, 'max_spend_required' as const])],
    };
  }

  const nowIso = input.now.toISOString();
  const draft = {
    schemaVersion: 'nft-purchase-intent/v1' as const,
    id: `nft-intent:${stableHashV1('nft-intent', {
      tenantId: input.tenantId,
      walletAddress: input.walletAddress.toLowerCase(),
      collectionSlug: extraction.collectionSlug,
      contractAddress: extraction.contractAddress,
      tokenId: extraction.tokenId,
      maxSpendWei,
      ...(input.requestId ? { requestId: input.requestId } : {}),
    }).slice(2, 26)}`,
    tenantId: input.tenantId,
    walletAddress: input.walletAddress,
    chainId: 8453 as const,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: 'ready' as const,
    intentHash: ZERO_HASH_V1,
    goal: 'nft_purchase' as const,
    inputSource: extraction.inputSource as NftIntentSourceV1,
    collectionSlug: extraction.collectionSlug,
    contractAddress: extraction.contractAddress as `0x${string}` | null,
    tokenId: extraction.tokenId as string,
    maxSpendWei,
    paymentAsset: 'native_eth' as const,
    quantity: 1 as const,
    tokenStandard: 'erc721' as const,
    verificationDepth: extraction.verificationDepth,
    executionRequested: false,
  };
  const intent = NftPurchaseIntentV1Schema.parse({
    ...draft,
    intentHash: hashNftPurchaseIntentV1(draft as unknown as NftPurchaseIntentV1),
  });
  return { status: 'ready', intent, extraction, issues: [] };
}
