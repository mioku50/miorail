import { z } from 'zod';
import { financialContentV1, stableHashV1, type HashV1 } from './hashing.js';
import { ExecutionCallV1Schema, hashApprovedCallsV1 } from './execution-contracts.js';
import {
  AddressV1Schema,
  AtomicAmountV1Schema,
  HashV1Schema,
  ProviderRefV1Schema,
  TimestampV1Schema,
  financialEntityFieldsV1,
  validateFinancialChronologyV1,
} from './primitives.js';
import {
  EvidenceSourceLinkV1Schema,
  ScoreConfidenceV1Schema,
  ScoreFreshnessV1Schema,
} from './score-contracts.js';

// ---------------------------------------------------------------------------
// T65 — NFT contract family (OpenSea).
//
// The fourth deliberately separate family. An NFT purchase has no
// expectedOutput/slippage (Swap), no APY (Earn), and no order/delivery legs
// (Commerce). It has ONE indivisible thing at ONE price, and the only question
// that matters afterwards is whether the buyer now owns it.
//
// Three rules give this file its shape.
//
//   1. IDENTITY IS chain + contract + tokenId. Nothing else. `name`, `image`
//      and `collectionName` are remote strings an attacker controls: two
//      different tokens can carry the same name and image. They live in
//      `display`, which is EXCLUDED from every identity hash, so a renamed or
//      spoofed NFT can never change what was bought or verified.
//
//   2. A SUCCESSFUL RECEIPT IS NOT A PURCHASE. `finalStatus: 'completed'`
//      requires a verified receipt AND an ERC-721 Transfer to the buyer AND an
//      `ownerOf(tokenId)` read that returns the buyer. A success with no
//      ownership is `reconciliation_required` — never a purchase.
//
//   3. THERE IS NO OVERALL SCORE. One marketplace's listing is not a market
//      comparison, and averaging four dimensions into a single number would
//      read as one. Dimensions stand alone, and `contract_safety` is
//      `not_scored` until an approved contract-risk source exists.
// ---------------------------------------------------------------------------

function addHashIssue(ctx: z.RefinementCtx, path: string, label: string): void {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [path],
    message: `${label} does not match the canonical V1 financial payload`,
  });
}

/** Unsigned base-10 comparison. Wei values are strings and never Number. */
function weiCompareV1(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a === b ? 0 : a < b ? -1 : 1;
}

// --- Asset identity ---------------------------------------------------------

/** V1 supports ERC-721 only. ERC-1155 is listed so a rejection can name what
 * it saw rather than failing as an unparseable string. */
export const NftTokenStandardV1Schema = z.enum(['erc721', 'erc1155']);
export type NftTokenStandardV1 = z.infer<typeof NftTokenStandardV1Schema>;

/** A token id is an unsigned integer of arbitrary size, kept as a decimal
 * string. Number would silently lose precision above 2^53. */
export const NftTokenIdV1Schema = z.string().regex(/^(0|[1-9][0-9]*)$/).max(78);

/**
 * REMOTE, UNTRUSTED display data.
 *
 * Every field here comes from metadata the collection owner controls. It is
 * carried so a human can recognise what they are buying, and it is excluded
 * from `assetHash` so it can never participate in identity. `imageUrl` is a
 * URL only — no HTML, no SVG payload, no data: document — and the surface is
 * required to pass it through the image policy before rendering it.
 */
export const NftDisplayV1Schema = z
  .object({
    name: z.string().max(200).nullable(),
    collectionName: z.string().max(200).nullable(),
    imageUrl: z.string().url().max(2048).nullable(),
    /** True when the media failed the image policy, so surfaces render the
     * placeholder instead of the remote asset. */
    imageBlocked: z.boolean(),
    imageBlockedReason: z.string().max(200).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.imageBlocked && value.imageBlockedReason === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['imageBlockedReason'],
        message: 'Blocked media must state why it was blocked',
      });
    }
  });
export type NftDisplayV1 = z.infer<typeof NftDisplayV1Schema>;

const NftAssetRefV1ObjectSchema = z
  .object({
    schemaVersion: z.literal('nft-asset-ref/v1'),
    assetHash: HashV1Schema,
    /** CAIP-2. Base mainnet only in V1; the field exists so a wrong chain is
     * REFUSED by value rather than assumed away. */
    chain: z.literal('eip155:8453'),
    contractAddress: AddressV1Schema,
    tokenId: NftTokenIdV1Schema,
    tokenStandard: NftTokenStandardV1Schema,
    collectionSlug: z.string().min(1).max(200).nullable(),
    display: NftDisplayV1Schema,
  })
  .strict();

export type NftAssetRefV1 = z.infer<typeof NftAssetRefV1ObjectSchema>;

/**
 * Identity hash over chain + contract + tokenId + standard ONLY.
 *
 * `display` and `collectionSlug` are excluded on purpose: a slug can be
 * reassigned and a name can be copied, so neither may change what this hash
 * says the asset is.
 */
export function hashNftAssetRefV1(value: NftAssetRefV1): HashV1 {
  return stableHashV1('nft-asset-ref/v1', {
    chain: value.chain,
    contractAddress: value.contractAddress,
    tokenId: value.tokenId,
    tokenStandard: value.tokenStandard,
  });
}

export const NftAssetRefV1Schema = NftAssetRefV1ObjectSchema.superRefine((value, ctx) => {
  if (value.assetHash !== hashNftAssetRefV1(value)) addHashIssue(ctx, 'assetHash', 'assetHash');
});

/** True when two references name the same token. Compares identity, never
 * display — a listing whose metadata changed is still the same listing. */
export function sameNftAssetV1(left: NftAssetRefV1, right: NftAssetRefV1): boolean {
  return hashNftAssetRefV1(left) === hashNftAssetRefV1(right);
}

// --- Intent -----------------------------------------------------------------

export const NftVerificationDepthV1Schema = z.enum(['standard', 'deep']);
export type NftVerificationDepthV1 = z.infer<typeof NftVerificationDepthV1Schema>;

/** How the user named the token. Recorded so a clarification can say which
 * part was ambiguous instead of asking for everything again. */
export const NftIntentSourceV1Schema = z.enum(['opensea_url', 'slug_and_token', 'contract_and_token']);
export type NftIntentSourceV1 = z.infer<typeof NftIntentSourceV1Schema>;

const NftPurchaseIntentV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1(
      'nft-purchase-intent/v1',
      z.enum(['draft', 'ready', 'needs_clarification', 'unsupported']),
    ),
    intentHash: HashV1Schema,
    goal: z.literal('nft_purchase'),
    inputSource: NftIntentSourceV1Schema,
    /** At least one of slug / contract must be present — enforced below. */
    collectionSlug: z.string().min(1).max(200).nullable(),
    contractAddress: AddressV1Schema.nullable(),
    tokenId: NftTokenIdV1Schema,
    /** The ceiling the user authorized, in wei. Null means "no ceiling was
     * stated" and forces the surface to ask before anything is prepared —
     * an unbounded NFT purchase is never assumed. */
    maxSpendWei: AtomicAmountV1Schema.nullable(),
    paymentAsset: z.literal('native_eth'),
    quantity: z.literal(1),
    tokenStandard: z.literal('erc721'),
    verificationDepth: NftVerificationDepthV1Schema,
    executionRequested: z.boolean(),
  })
  .strict();

export type NftPurchaseIntentV1 = z.infer<typeof NftPurchaseIntentV1ObjectSchema>;

export function hashNftPurchaseIntentV1(value: NftPurchaseIntentV1): HashV1 {
  return stableHashV1('nft-purchase-intent/v1', financialContentV1(value, ['intentHash']));
}

export const NftPurchaseIntentV1Schema = NftPurchaseIntentV1ObjectSchema.superRefine((value, ctx) => {
  validateFinancialChronologyV1(value, ctx);
  if (value.intentHash !== hashNftPurchaseIntentV1(value)) addHashIssue(ctx, 'intentHash', 'intentHash');
  if (value.collectionSlug === null && value.contractAddress === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contractAddress'],
      message: 'An NFT intent needs a collection slug or a contract address',
    });
  }
  if (value.status === 'ready' && value.maxSpendWei === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maxSpendWei'],
      message: 'A ready NFT intent requires an explicit spend ceiling',
    });
  }
});

// --- Listing candidate ------------------------------------------------------

/** Only `active` can be bought. Every other value is a REASON the purchase
 * stops, which is why they are modelled rather than filtered away. */
export const NftListingStatusV1Schema = z.enum(['active', 'expired', 'cancelled', 'filled', 'unknown']);
export type NftListingStatusV1 = z.infer<typeof NftListingStatusV1Schema>;

/** Seaport order components the fulfiller needs. Recorded from the provider,
 * re-checked immediately before a signature. */
const NftSeaportOrderV1Schema = z
  .object({
    orderHash: HashV1Schema,
    protocolAddress: AddressV1Schema,
    seller: AddressV1Schema,
    /** OpenSea marks private listings by naming a single permitted taker. A
     * private listing is refused, so the field exists to detect it. */
    restrictedTaker: AddressV1Schema.nullable(),
  })
  .strict();

const NftListingCandidateV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1(
      'nft-listing-candidate/v1',
      z.enum(['quoted', 'selected', 'expired', 'invalid', 'rejected']),
    ),
    candidateHash: HashV1Schema,
    intentHash: HashV1Schema,
    provider: ProviderRefV1Schema,
    asset: NftAssetRefV1Schema,
    order: NftSeaportOrderV1Schema,
    listingStatus: NftListingStatusV1Schema,
    /** The exact listing price in wei, native ETH. */
    listingPriceWei: AtomicAmountV1Schema,
    /** Creator/marketplace fees already included in `listingPriceWei` when the
     * provider quotes them inclusively; stated separately so the Route Card
     * can show the policy rather than implying there is none. */
    creatorFeeBps: z.number().int().min(0).max(10_000).nullable(),
    creatorFeePolicy: z.enum(['included_in_price', 'added_at_fulfillment', 'unknown']),
    paymentAsset: z.literal('native_eth'),
    estimatedGasWei: AtomicAmountV1Schema.nullable(),
    observedAt: TimestampV1Schema,
    listingExpiresAt: TimestampV1Schema,
  })
  .strict();

export type NftListingCandidateV1 = z.infer<typeof NftListingCandidateV1ObjectSchema>;

export function hashNftListingCandidateV1(value: NftListingCandidateV1): HashV1 {
  const content = financialContentV1(value, ['candidateHash', 'asset']);
  return stableHashV1('nft-listing-candidate/v1', { ...content, assetHash: value.asset.assetHash });
}

export const NftListingCandidateV1Schema = NftListingCandidateV1ObjectSchema.superRefine((value, ctx) => {
  validateFinancialChronologyV1(value, ctx);
  if (value.candidateHash !== hashNftListingCandidateV1(value)) {
    addHashIssue(ctx, 'candidateHash', 'candidateHash');
  }
  if (value.asset.tokenStandard !== 'erc721') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['asset', 'tokenStandard'],
      message: 'V1 buys ERC-721 only',
    });
  }
  if (BigInt(value.listingPriceWei) <= BigInt(0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['listingPriceWei'],
      message: 'A listing price must be positive',
    });
  }
  if (value.status === 'selected' && value.listingStatus !== 'active') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['listingStatus'],
      message: 'Only an active listing can be selected',
    });
  }
  if (value.order.restrictedTaker !== null && value.status === 'selected') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['order', 'restrictedTaker'],
      message: 'A private listing cannot be selected',
    });
  }
});

/** Total cost as the user experiences it: price plus gas. Gas is nullable, and
 * when it is missing the total is NOT silently the price — the caller gets
 * null and must say the estimate is unavailable. */
export function nftTotalCostWeiV1(candidate: NftListingCandidateV1): string | null {
  if (candidate.estimatedGasWei === null) return null;
  return (BigInt(candidate.listingPriceWei) + BigInt(candidate.estimatedGasWei)).toString();
}

// --- Evidence ---------------------------------------------------------------

export const NftEvidenceKindV1Schema = z.enum([
  'nft_metadata',
  'contract_standard',
  'collection_identity',
  'listing_order',
  'fulfillment_data',
  'ownership_read',
]);
export type NftEvidenceKindV1 = z.infer<typeof NftEvidenceKindV1Schema>;

const NftEvidenceRecordV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1('nft-evidence-record/v1', z.enum(['recorded', 'stale', 'rejected'])),
    evidenceHash: HashV1Schema,
    intentHash: HashV1Schema,
    candidateHash: HashV1Schema.nullable(),
    provider: ProviderRefV1Schema,
    evidenceKind: NftEvidenceKindV1Schema,
    /** Identity of what was read, so evidence can never be attached to a
     * different token than the one it describes. */
    assetHash: HashV1Schema,
    orderHash: HashV1Schema.nullable(),
    protocolAddress: AddressV1Schema.nullable(),
    seller: AddressV1Schema.nullable(),
    priceWei: AtomicAmountV1Schema.nullable(),
    currency: z.enum(['native_eth', 'other']).nullable(),
    listingStatus: NftListingStatusV1Schema.nullable(),
    listingExpiresAt: TimestampV1Schema.nullable(),
    observedAt: TimestampV1Schema,
    /** Hashes of the exact request and response, so a later fulfillment can be
     * compared against what was actually observed rather than re-fetched and
     * assumed identical. */
    requestHash: HashV1Schema,
    responseHash: HashV1Schema,
    freeOrPaid: z.enum(['free', 'paid']),
  })
  .strict();

export type NftEvidenceRecordV1 = z.infer<typeof NftEvidenceRecordV1ObjectSchema>;

export function hashNftEvidenceRecordV1(value: NftEvidenceRecordV1): HashV1 {
  return stableHashV1('nft-evidence-record/v1', financialContentV1(value, ['evidenceHash']));
}

export const NftEvidenceRecordV1Schema = NftEvidenceRecordV1ObjectSchema.superRefine((value, ctx) => {
  validateFinancialChronologyV1(value, ctx);
  if (value.evidenceHash !== hashNftEvidenceRecordV1(value)) addHashIssue(ctx, 'evidenceHash', 'evidenceHash');
});

// --- Scoring ----------------------------------------------------------------

export const NftScoreDimensionNameV1Schema = z.enum([
  'total_cost',
  'listing_freshness',
  'route_simplicity',
  'contract_safety',
]);
export type NftScoreDimensionNameV1 = z.infer<typeof NftScoreDimensionNameV1Schema>;

export const NFT_SCORE_DIMENSIONS_V1: readonly NftScoreDimensionNameV1[] = [
  'total_cost',
  'listing_freshness',
  'route_simplicity',
  'contract_safety',
];

const NftScoreDimensionV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1('nft-score-dimension/v1', z.enum(['scored', 'not_scored'])),
    dimensionHash: HashV1Schema,
    intentHash: HashV1Schema,
    candidateHash: HashV1Schema,
    dimension: NftScoreDimensionNameV1Schema,
    score: z.number().int().min(0).max(100).nullable(),
    notScoredReason: z
      .enum(['not_requested', 'insufficient_evidence', 'stale_evidence', 'no_approved_source', 'scoring_error'])
      .nullable(),
    confidence: ScoreConfidenceV1Schema.nullable(),
    sources: z.array(EvidenceSourceLinkV1Schema),
    freshness: ScoreFreshnessV1Schema.nullable(),
    scoringVersion: z.string().min(1).max(120),
    missingEvidence: z.array(NftEvidenceKindV1Schema),
  })
  .strict();

export type NftScoreDimensionV1 = z.infer<typeof NftScoreDimensionV1ObjectSchema>;

export function hashNftScoreDimensionV1(value: NftScoreDimensionV1): HashV1 {
  return stableHashV1('nft-score-dimension/v1', financialContentV1(value, ['dimensionHash']));
}

export const NftScoreDimensionV1Schema = NftScoreDimensionV1ObjectSchema.superRefine((value, ctx) => {
  validateFinancialChronologyV1(value, ctx);
  if (value.dimensionHash !== hashNftScoreDimensionV1(value)) addHashIssue(ctx, 'dimensionHash', 'dimensionHash');
  if (value.status === 'not_scored') {
    if (value.score !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['score'], message: 'Not scored dimensions must use score=null' });
    }
    if (value.confidence !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['confidence'], message: 'Not scored dimensions must use confidence=null' });
    }
    if (value.sources.length !== 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sources'], message: 'Not scored dimensions must not claim evidence sources' });
    }
    if (value.notScoredReason === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['notScoredReason'], message: 'Not scored dimensions require an explicit reason' });
    }
  } else if (value.score === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['score'], message: 'A scored dimension requires a score' });
  }
});

// --- Route Card -------------------------------------------------------------

/** The ONLY recommendation string this family may make. One marketplace is not
 * a market, and the card must not imply it compared any others. */
export const NFT_RECOMMENDATION_COPY_V1 = 'Best active OpenSea listing for this NFT';

const NftRouteCardV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1(
      'nft-route-card/v1',
      z.enum(['ready', 'constrained', 'degraded', 'failed']),
    ),
    routeCardHash: HashV1Schema,
    intentHash: HashV1Schema,
    /** Fixed copy. A literal, so no surface and no future edit can turn a
     * single-venue listing into a cross-market claim. */
    recommendation: z.literal(NFT_RECOMMENDATION_COPY_V1),
    asset: NftAssetRefV1Schema,
    candidate: NftListingCandidateV1Schema.nullable(),
    /** Deliberately NO overall score. Four dimensions, standing alone. */
    dimensions: z.array(NftScoreDimensionV1Schema).length(4),
    evidenceHashes: z.array(HashV1Schema),
    /** What could not be established, stated rather than omitted. */
    evidenceGaps: z.array(NftEvidenceKindV1Schema),
    maxSpendWei: AtomicAmountV1Schema,
    totalCostWei: AtomicAmountV1Schema.nullable(),
    failureReason: z.string().min(1).max(200).nullable(),
    expiresAt: TimestampV1Schema,
  })
  .strict();

export type NftRouteCardV1 = z.infer<typeof NftRouteCardV1ObjectSchema>;

export function hashNftRouteCardV1(value: NftRouteCardV1): HashV1 {
  const content = financialContentV1(value, ['routeCardHash', 'asset', 'candidate', 'dimensions']);
  return stableHashV1('nft-route-card/v1', {
    ...content,
    assetHash: value.asset.assetHash,
    candidateHash: value.candidate?.candidateHash ?? null,
    dimensionHashes: value.dimensions.map((dimension) => dimension.dimensionHash),
  });
}

export const NftRouteCardV1Schema = NftRouteCardV1ObjectSchema.superRefine((value, ctx) => {
  validateFinancialChronologyV1(value, ctx);
  if (value.routeCardHash !== hashNftRouteCardV1(value)) addHashIssue(ctx, 'routeCardHash', 'routeCardHash');
  const names = value.dimensions.map((dimension) => dimension.dimension);
  for (const required of NFT_SCORE_DIMENSIONS_V1) {
    if (!names.includes(required)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dimensions'],
        message: `Missing score dimension: ${required}`,
      });
    }
  }
  if (value.status === 'ready') {
    if (value.candidate === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['candidate'], message: 'A ready card requires a listing' });
    } else {
      if (!sameNftAssetV1(value.candidate.asset, value.asset)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['candidate', 'asset'],
          message: 'The listing on this card is for a different token',
        });
      }
      if (weiCompareV1(value.candidate.listingPriceWei, value.maxSpendWei) > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['candidate', 'listingPriceWei'],
          message: 'A ready card cannot cost more than the authorized ceiling',
        });
      }
    }
  }
  if (value.status === 'failed' && value.failureReason === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['failureReason'], message: 'A failed card must state why' });
  }
});

// --- Purchase Blueprint -----------------------------------------------------

export const NftPurchaseBlueprintStatusV1Schema = z.enum([
  'draft',
  'simulated',
  'awaiting_approval',
  'approved',
  'submitted',
  // The batch left the wallet but we could not establish what became of it.
  // Kept distinct from `submitted` on purpose: collapsing the two would let a
  // submission we cannot see be displayed as one we can.
  'submitted_unknown',
  'confirmed',
  'failed',
  // The user refused in the wallet. Nothing was sent, so nothing is pending
  // and no proof is opened — but the refusal itself is a fact worth keeping.
  'cancelled',
  'expired',
]);
export type NftPurchaseBlueprintStatusV1 = z.infer<typeof NftPurchaseBlueprintStatusV1Schema>;

const NftPurchaseBlueprintV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1('nft-purchase-blueprint/v1', NftPurchaseBlueprintStatusV1Schema),
    blueprintHash: HashV1Schema,
    intentHash: HashV1Schema,
    candidateHash: HashV1Schema,
    routeCardHash: HashV1Schema,
    orderHash: HashV1Schema,
    protocolAddress: AddressV1Schema,
    asset: NftAssetRefV1Schema,
    buyer: AddressV1Schema,
    paymentAsset: z.literal('native_eth'),
    listingPriceWei: AtomicAmountV1Schema,
    maxSpendWei: AtomicAmountV1Schema,
    /** Exactly one call. Encoded server-side from the provider's fulfillment
     * data through a pinned ABI — the client never supplies calldata. */
    calls: z.array(ExecutionCallV1Schema).length(1),
    callsHash: HashV1Schema,
    approvedCallsHash: HashV1Schema.nullable(),
    /** Hash of the fulfillment response this calldata was built from, so the
     * safety kernel can prove the bytes were not swapped afterwards. */
    fulfillmentResponseHash: HashV1Schema,
    expiresAt: TimestampV1Schema,
  })
  .strict();

export type NftPurchaseBlueprintV1 = z.infer<typeof NftPurchaseBlueprintV1ObjectSchema>;

export function hashNftPurchaseBlueprintV1(value: NftPurchaseBlueprintV1): HashV1 {
  const content = financialContentV1(value, ['blueprintHash', 'asset', 'calls', 'approvedCallsHash']);
  return stableHashV1('nft-purchase-blueprint/v1', {
    ...content,
    assetHash: value.asset.assetHash,
    callsHash: value.callsHash,
  });
}

export const NftPurchaseBlueprintV1Schema = NftPurchaseBlueprintV1ObjectSchema.superRefine((value, ctx) => {
  validateFinancialChronologyV1(value, ctx);
  if (value.blueprintHash !== hashNftPurchaseBlueprintV1(value)) {
    addHashIssue(ctx, 'blueprintHash', 'blueprintHash');
  }
  if (value.callsHash !== hashApprovedCallsV1(value.calls)) {
    addHashIssue(ctx, 'callsHash', 'callsHash');
  }
  const call = value.calls[0];
  if (call) {
    // The one call must be the fulfillment, sent to the pinned Seaport
    // protocol address the order itself names.
    if (call.to.toLowerCase() !== value.protocolAddress.toLowerCase()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['calls', 0, 'to'],
        message: 'The purchase call must target the order’s own protocol address',
      });
    }
    // Native ETH pays for this. A zero-value call cannot buy anything, and a
    // call above the ceiling is the failure this whole family exists to stop.
    if (BigInt(call.valueWei) <= BigInt(0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['calls', 0, 'valueWei'],
        message: 'A native-ETH purchase must carry a positive value',
      });
    }
    if (weiCompareV1(call.valueWei, value.maxSpendWei) > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['calls', 0, 'valueWei'],
        message: 'The purchase call exceeds the authorized ceiling',
      });
    }
  }
  if (weiCompareV1(value.listingPriceWei, value.maxSpendWei) > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['listingPriceWei'],
      message: 'The listing costs more than the authorized ceiling',
    });
  }
  if (value.asset.tokenStandard !== 'erc721') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['asset', 'tokenStandard'], message: 'V1 buys ERC-721 only' });
  }
  const signable =
    value.status === 'approved' ||
    value.status === 'submitted' ||
    value.status === 'submitted_unknown' ||
    value.status === 'confirmed';
  if (signable && value.approvedCallsHash === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['approvedCallsHash'],
      message: 'An approved blueprint must record the calls the user approved',
    });
  }
  if (value.approvedCallsHash !== null && value.approvedCallsHash !== value.callsHash) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['approvedCallsHash'],
      message: 'The approved calls differ from the calls in this blueprint',
    });
  }
});

// --- Proof ------------------------------------------------------------------

/**
 * The onchain ownership read. `ownerOf(tokenId)` at a stated block — the only
 * thing in this family that can say a purchase happened.
 */
const NftOwnershipReadV1Schema = z
  .object({
    status: z.enum(['verified', 'unverified', 'mismatch']),
    owner: AddressV1Schema.nullable(),
    blockNumber: z.string().regex(/^(0|[1-9][0-9]*)$/).max(20).nullable(),
    observedAt: TimestampV1Schema.nullable(),
    unavailableReason: z.string().min(1).max(200).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === 'verified') {
      if (value.owner === null || value.blockNumber === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['owner'],
          message: 'A verified ownership read requires an owner and the block it was read at',
        });
      }
    } else if (value.unavailableReason === null && value.status === 'unverified') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unavailableReason'],
        message: 'An unverified ownership read must state why',
      });
    }
  });
export type NftOwnershipReadV1 = z.infer<typeof NftOwnershipReadV1Schema>;

const NftTransferLegV1Schema = z
  .object({
    status: z.enum(['observed', 'absent', 'wrong_recipient']),
    fromAddress: AddressV1Schema.nullable(),
    toAddress: AddressV1Schema.nullable(),
    logIndex: z.number().int().min(0).nullable(),
  })
  .strict();
export type NftTransferLegV1 = z.infer<typeof NftTransferLegV1Schema>;

const NftReceiptLegV1Schema = z
  .object({
    status: z.enum(['pending', 'success', 'reverted', 'unknown']),
    transactionHash: HashV1Schema.nullable(),
    blockNumber: z.string().regex(/^(0|[1-9][0-9]*)$/).max(20).nullable(),
    gasUsed: AtomicAmountV1Schema.nullable(),
    /** What the transaction actually spent, read from the chain — never the
     * quoted price copied forward. */
    actualNativeValueWei: AtomicAmountV1Schema.nullable(),
  })
  .strict();
export type NftReceiptLegV1 = z.infer<typeof NftReceiptLegV1Schema>;

export const NftProofFinalStatusV1Schema = z.enum([
  'pending',
  'completed',
  'reconciliation_required',
  'transaction_failed',
  'failed',
]);
export type NftProofFinalStatusV1 = z.infer<typeof NftProofFinalStatusV1Schema>;

/**
 * THE rule of this family, in one place.
 *
 * `completed` needs all three of: a verified successful receipt, an ERC-721
 * Transfer to the buyer, and an `ownerOf` read that returns the buyer. Any
 * successful transaction that cannot show ownership is
 * `reconciliation_required` — a state that keeps looking, never a purchase.
 *
 * The schema below re-derives this and rejects a proof that disagrees, so no
 * surface, migration, or future caller can express "the transaction succeeded,
 * therefore they own it".
 */
export function deriveNftProofFinalStatusV1(input: {
  receipt: NftReceiptLegV1;
  transfer: NftTransferLegV1;
  ownership: NftOwnershipReadV1;
  buyer: string;
}): NftProofFinalStatusV1 {
  const { receipt, transfer, ownership } = input;
  if (receipt.status === 'reverted') return 'transaction_failed';
  if (receipt.status === 'pending' || receipt.status === 'unknown') return 'pending';

  const buyer = input.buyer.toLowerCase();
  const transferred = transfer.status === 'observed' && transfer.toAddress?.toLowerCase() === buyer;
  const owned = ownership.status === 'verified' && ownership.owner?.toLowerCase() === buyer;

  if (transferred && owned) return 'completed';
  // The transaction succeeded and the token did NOT reach the buyer. That is
  // not a failed purchase to file away — it is money spent with an unexplained
  // outcome, and it stays open until someone explains it.
  if (transfer.status === 'wrong_recipient' || ownership.status === 'mismatch') return 'failed';
  return 'reconciliation_required';
}

const NftPurchaseProofV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1('nft-purchase-proof/v1', z.enum(['open', 'finalized'])),
    proofHash: HashV1Schema,
    intentHash: HashV1Schema,
    blueprintHash: HashV1Schema,
    approvedCallsHash: HashV1Schema,
    orderHash: HashV1Schema,
    asset: NftAssetRefV1Schema,
    buyer: AddressV1Schema,
    /** The seller as the order named it, kept so "previous owner" is a claim
     * about the order and `transfer.fromAddress` is a claim about the chain. */
    seller: AddressV1Schema,
    listingPriceWei: AtomicAmountV1Schema,
    receipt: NftReceiptLegV1Schema,
    transfer: NftTransferLegV1Schema,
    ownership: NftOwnershipReadV1Schema,
    finalStatus: NftProofFinalStatusV1Schema,
    finalizedAt: TimestampV1Schema.nullable(),
  })
  .strict();

export type NftPurchaseProofV1 = z.infer<typeof NftPurchaseProofV1ObjectSchema>;

export function hashNftPurchaseProofV1(value: NftPurchaseProofV1): HashV1 {
  const content = financialContentV1(value, ['proofHash', 'asset']);
  return stableHashV1('nft-purchase-proof/v1', { ...content, assetHash: value.asset.assetHash });
}

export const NftPurchaseProofV1Schema = NftPurchaseProofV1ObjectSchema.superRefine((value, ctx) => {
  validateFinancialChronologyV1(value, ctx);
  if (value.proofHash !== hashNftPurchaseProofV1(value)) addHashIssue(ctx, 'proofHash', 'proofHash');
  const derived = deriveNftProofFinalStatusV1({
    receipt: value.receipt,
    transfer: value.transfer,
    ownership: value.ownership,
    buyer: value.buyer,
  });
  if (value.finalStatus !== derived) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['finalStatus'],
      message: `finalStatus must be the derived ${derived}, not ${value.finalStatus}`,
    });
  }
  if (value.status === 'finalized' && value.finalizedAt === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['finalizedAt'], message: 'A finalized proof needs its time' });
  }
  if (value.finalStatus === 'reconciliation_required' && value.status === 'finalized') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['status'],
      message: 'A proof awaiting reconciliation is not finalized',
    });
  }
});

// --- Proof events -----------------------------------------------------------

export const NftProofEventKindV1Schema = z.enum([
  'blueprint_prepared',
  'blueprint_approved',
  'submission_recorded',
  'receipt_observed',
  'transfer_observed',
  'ownership_read',
  'reconciliation_attempted',
  'finalized',
]);
export type NftProofEventKindV1 = z.infer<typeof NftProofEventKindV1Schema>;

const NftProofEventV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1('nft-proof-event/v1', z.enum(['recorded'])),
    eventHash: HashV1Schema,
    proofHash: HashV1Schema,
    sequence: z.number().int().min(0),
    eventKind: NftProofEventKindV1Schema,
    finalStatus: NftProofFinalStatusV1Schema,
    detail: z.string().max(400).nullable(),
    observedAt: TimestampV1Schema,
  })
  .strict();

export type NftProofEventV1 = z.infer<typeof NftProofEventV1ObjectSchema>;

export function hashNftProofEventV1(value: NftProofEventV1): HashV1 {
  return stableHashV1('nft-proof-event/v1', financialContentV1(value, ['eventHash']));
}

export const NftProofEventV1Schema = NftProofEventV1ObjectSchema.superRefine((value, ctx) => {
  validateFinancialChronologyV1(value, ctx);
  if (value.eventHash !== hashNftProofEventV1(value)) addHashIssue(ctx, 'eventHash', 'eventHash');
});
