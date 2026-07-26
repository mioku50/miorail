import {
  NFT_RECOMMENDATION_COPY_V1,
  NFT_SCORE_DIMENSIONS_V1,
  NftAssetRefV1Schema,
  NftEvidenceRecordV1Schema,
  NftListingCandidateV1Schema,
  NftRouteCardV1Schema,
  NftScoreDimensionV1Schema,
  ZERO_HASH_V1,
  hashNftAssetRefV1,
  hashNftEvidenceRecordV1,
  hashNftListingCandidateV1,
  hashNftRouteCardV1,
  hashNftScoreDimensionV1,
  nftTotalCostWeiV1,
  stableHashV1,
  type NftAssetRefV1,
  type NftEvidenceKindV1,
  type NftEvidenceRecordV1,
  type NftListingCandidateV1,
  type NftPurchaseIntentV1,
  type NftRouteCardV1,
  type NftScoreDimensionNameV1,
  type NftScoreDimensionV1,
} from '@mioagent/route-domain';
import { NFT_CHAIN_CAIP2_V1, NFT_LISTING_TTL_MS_DEFAULT_V1 } from './pinned-config.js';
import type { NftObservedAssetV1, NftObservedListingV1 } from './opensea-gateway.js';
import { verifyNftListingV1, type NftVerificationReasonV1 } from './verification.js';

// ---------------------------------------------------------------------------
// T65 §4 / §5 — evidence, scoring, Route Card.
//
// Two rules run through all of it.
//
// A GAP IS SHOWN, NOT FILLED. When gas cannot be estimated the total cost is
// null and `total_cost` is `not_scored` — never the listing price wearing the
// word "total". When no contract-risk source exists, `contract_safety` says so
// in the same sentence every time.
//
// THERE IS NO OVERALL NUMBER. Four dimensions stand alone. Averaging them
// would produce a single figure that reads as a market verdict, and one
// marketplace's listing is not a market.
// ---------------------------------------------------------------------------

export const NFT_SCORING_VERSION_V1 = 'nft-scoring/v1';

/** The one sentence this deployment says about contract risk. Fixed, so it
 * cannot drift into sounding like a check that was performed. */
export const NFT_CONTRACT_SAFETY_COPY_V1 = 'Not scored · No approved contract-risk source';

const SCORE_DIMENSION_ID_PREFIX_V1 = 'nft-score';

interface EntityStampV1 {
  tenantId: string;
  walletAddress: `0x${string}`;
  now: Date;
}

function stamp(input: EntityStampV1) {
  const iso = input.now.toISOString();
  return {
    tenantId: input.tenantId,
    walletAddress: input.walletAddress,
    chainId: 8453 as const,
    createdAt: iso,
    updatedAt: iso,
  };
}

// --- Asset ------------------------------------------------------------------

/**
 * Builds the asset reference.
 *
 * `imageBlocked` is decided by the CALLER's image policy and by OpenSea's own
 * moderation flags — this function never decides that remote media is safe,
 * only records the decision that was made.
 */
export function buildNftAssetRefV1(input: {
  observed: NftObservedAssetV1;
  imageAllowed: boolean;
  imageBlockedReason?: string | null;
}): NftAssetRefV1 {
  const blockedByProvider = input.observed.isDisabled || input.observed.isNsfw;
  const blocked = !input.imageAllowed || blockedByProvider || input.observed.imageUrl === null;
  const reason = blocked
    ? (input.imageBlockedReason ??
      (blockedByProvider
        ? 'OpenSea flagged this item as disabled or sensitive'
        : input.observed.imageUrl === null
          ? 'This item has no image'
          : 'The image failed this deployment’s media policy'))
    : null;
  const base = {
    schemaVersion: 'nft-asset-ref/v1' as const,
    assetHash: ZERO_HASH_V1,
    chain: NFT_CHAIN_CAIP2_V1,
    contractAddress: input.observed.contractAddress as `0x${string}`,
    tokenId: input.observed.tokenId,
    tokenStandard: 'erc721' as const,
    collectionSlug: input.observed.collectionSlug,
    display: {
      name: input.observed.name,
      collectionName: input.observed.collectionSlug,
      // A blocked image is not carried forward at all. A URL that survives
      // into the contract is a URL something will eventually try to load.
      imageUrl: blocked ? null : input.observed.imageUrl,
      imageBlocked: blocked,
      imageBlockedReason: reason,
    },
  };
  return NftAssetRefV1Schema.parse({ ...base, assetHash: hashNftAssetRefV1(base as NftAssetRefV1) });
}

// --- Candidate --------------------------------------------------------------

export function buildNftCandidateV1(input: {
  intent: NftPurchaseIntentV1;
  asset: NftAssetRefV1;
  listing: NftObservedListingV1;
  estimatedGasWei: string | null;
  now: Date;
}): NftListingCandidateV1 {
  const base = {
    ...stamp({ tenantId: input.intent.tenantId, walletAddress: input.intent.walletAddress, now: input.now }),
    schemaVersion: 'nft-listing-candidate/v1' as const,
    id: `nft-candidate:${stableHashV1('nft-candidate', {
      intentHash: input.intent.intentHash,
      orderHash: input.listing.orderHash,
    }).slice(2, 26)}`,
    status: 'quoted' as const,
    candidateHash: ZERO_HASH_V1,
    intentHash: input.intent.intentHash,
    provider: { id: 'opensea', displayName: 'OpenSea', kind: 'aggregator' as const, operator: 'OpenSea' },
    asset: input.asset,
    order: {
      orderHash: input.listing.orderHash as `0x${string}`,
      protocolAddress: input.listing.protocolAddress as `0x${string}`,
      seller: input.listing.seller as `0x${string}`,
      // The gateway refuses a listing whose consideration holds the NFT, so a
      // candidate that exists at all was not reserved for another taker.
      restrictedTaker: null,
    },
    listingStatus: input.listing.listingStatus,
    listingPriceWei: input.listing.totalWei,
    // Fees are already inside the consideration total OpenSea quoted, which
    // the adapter verified. Stated so the card shows the policy rather than
    // implying there is none.
    creatorFeeBps: null,
    creatorFeePolicy: 'included_in_price' as const,
    paymentAsset: 'native_eth' as const,
    estimatedGasWei: input.estimatedGasWei,
    observedAt: input.listing.observedAt,
    listingExpiresAt: input.listing.listingExpiresAt,
  };
  return NftListingCandidateV1Schema.parse({
    ...base,
    candidateHash: hashNftListingCandidateV1(base as unknown as NftListingCandidateV1),
  });
}

// --- Evidence ---------------------------------------------------------------

export function buildNftEvidenceV1(input: {
  intent: NftPurchaseIntentV1;
  asset: NftAssetRefV1;
  candidateHash: string | null;
  observedAsset: NftObservedAssetV1;
  observedListing: NftObservedListingV1 | null;
  now: Date;
}): NftEvidenceRecordV1[] {
  const records: NftEvidenceRecordV1[] = [];
  const push = (
    evidenceKind: NftEvidenceKindV1,
    fields: Partial<NftEvidenceRecordV1>,
    source: { requestHash: string; responseHash: string; observedAt: string },
  ) => {
    const base = {
      ...stamp({ tenantId: input.intent.tenantId, walletAddress: input.intent.walletAddress, now: input.now }),
      schemaVersion: 'nft-evidence-record/v1' as const,
      id: `nft-evidence:${stableHashV1('nft-evidence', {
        intentHash: input.intent.intentHash,
        evidenceKind,
        responseHash: source.responseHash,
      }).slice(2, 26)}`,
      status: 'recorded' as const,
      evidenceHash: ZERO_HASH_V1,
      intentHash: input.intent.intentHash,
      candidateHash: (input.candidateHash ?? null) as `0x${string}` | null,
      provider: { id: 'opensea', displayName: 'OpenSea', kind: 'aggregator' as const, operator: 'OpenSea' },
      evidenceKind,
      assetHash: input.asset.assetHash,
      orderHash: null,
      protocolAddress: null,
      seller: null,
      priceWei: null,
      currency: null,
      listingStatus: null,
      listingExpiresAt: null,
      observedAt: source.observedAt,
      requestHash: source.requestHash as `0x${string}`,
      responseHash: source.responseHash as `0x${string}`,
      freeOrPaid: 'free' as const,
      ...fields,
    };
    records.push(
      NftEvidenceRecordV1Schema.parse({
        ...base,
        evidenceHash: hashNftEvidenceRecordV1(base as unknown as NftEvidenceRecordV1),
      }),
    );
  };

  push('nft_metadata', {}, input.observedAsset);
  push('contract_standard', {}, input.observedAsset);
  push('collection_identity', {}, input.observedAsset);

  if (input.observedListing) {
    push(
      'listing_order',
      {
        orderHash: input.observedListing.orderHash as `0x${string}`,
        protocolAddress: input.observedListing.protocolAddress as `0x${string}`,
        seller: input.observedListing.seller as `0x${string}`,
        priceWei: input.observedListing.totalWei,
        currency: 'native_eth',
        listingStatus: input.observedListing.listingStatus,
        listingExpiresAt: input.observedListing.listingExpiresAt,
      },
      input.observedListing,
    );
  }
  return records;
}

/** Kinds that were expected but not recorded. Shown on the card so a missing
 * check reads as missing rather than as passed. */
export function nftEvidenceGapsV1(records: readonly NftEvidenceRecordV1[]): NftEvidenceKindV1[] {
  const present = new Set(records.map((record) => record.evidenceKind));
  const expected: NftEvidenceKindV1[] = ['nft_metadata', 'contract_standard', 'collection_identity', 'listing_order'];
  return expected.filter((kind) => !present.has(kind));
}

// --- Scoring ----------------------------------------------------------------

function buildDimensionV1(input: {
  intent: NftPurchaseIntentV1;
  candidateHash: string;
  dimension: NftScoreDimensionNameV1;
  score: number | null;
  notScoredReason: NftScoreDimensionV1['notScoredReason'];
  /** The evidence this dimension was actually derived from. A scored
   * dimension links its real sources; there is no count-shaped placeholder. */
  sources: readonly NftEvidenceRecordV1[];
  freshness: { observedAt: string; expiresAt: string | null; ageSeconds: number } | null;
  missingEvidence: NftEvidenceKindV1[];
  now: Date;
}): NftScoreDimensionV1 {
  const scored = input.score !== null;
  const base = {
    ...stamp({ tenantId: input.intent.tenantId, walletAddress: input.intent.walletAddress, now: input.now }),
    schemaVersion: 'nft-score-dimension/v1' as const,
    id: `${SCORE_DIMENSION_ID_PREFIX_V1}:${stableHashV1('nft-score-dimension', {
      candidateHash: input.candidateHash,
      dimension: input.dimension,
    }).slice(2, 26)}`,
    status: (scored ? 'scored' : 'not_scored') as 'scored' | 'not_scored',
    dimensionHash: ZERO_HASH_V1,
    intentHash: input.intent.intentHash,
    candidateHash: input.candidateHash as `0x${string}`,
    dimension: input.dimension,
    score: input.score,
    notScoredReason: scored ? null : input.notScoredReason,
    // One venue, directly observed. `high` would claim a corroboration that a
    // single marketplace read cannot provide.
    confidence: scored ? ({ value: 0.5, label: 'medium' as const }) : null,
    sources: scored
      ? input.sources.map((record) => ({
          evidenceId: record.id,
          evidenceHash: record.evidenceHash,
          providerId: record.provider.id,
        }))
      : [],
    freshness:
      scored && input.freshness !== null
        ? {
            observedAt: input.freshness.observedAt,
            expiresAt: input.freshness.expiresAt,
            ageSeconds: input.freshness.ageSeconds,
            state: (input.freshness.ageSeconds * 1000 > NFT_LISTING_TTL_MS_DEFAULT_V1 ? 'stale' : 'fresh') as
              | 'fresh'
              | 'stale',
          }
        : null,
    scoringVersion: NFT_SCORING_VERSION_V1,
    missingEvidence: scored ? [] : input.missingEvidence,
  };
  return NftScoreDimensionV1Schema.parse({
    ...base,
    dimensionHash: hashNftScoreDimensionV1(base as unknown as NftScoreDimensionV1),
  });
}

/**
 * The four dimensions. No overall number, by construction — this returns a
 * list and there is nowhere to put an average.
 *
 * With one venue there is nothing to rank against, so each score is measured
 * against something the user actually stated or the chain actually reports:
 * the ceiling they authorized, the expiry the order carries, the call count
 * the blueprint will hold. A score with nothing behind it is `not_scored`.
 */
export function scoreNftCandidateV1(input: {
  intent: NftPurchaseIntentV1;
  candidate: NftListingCandidateV1;
  evidence: readonly NftEvidenceRecordV1[];
  now: Date;
}): NftScoreDimensionV1[] {
  const { intent, candidate } = input;
  const dimension = (
    name: NftScoreDimensionNameV1,
    score: number | null,
    notScoredReason: NftScoreDimensionV1['notScoredReason'],
    missingEvidence: NftEvidenceKindV1[] = [],
    ageSeconds: number | null = null,
  ) =>
    buildDimensionV1({
      intent,
      candidateHash: candidate.candidateHash,
      dimension: name,
      score,
      notScoredReason,
      sources: input.evidence,
      freshness:
        ageSeconds === null
          ? null
          : { observedAt: candidate.observedAt, expiresAt: candidate.listingExpiresAt, ageSeconds },
      missingEvidence,
      now: input.now,
    });

  // total_cost — how much of the authorized ceiling the whole purchase uses.
  // Without a gas estimate there is no total, and the listing price wearing
  // the word "total" would be the lie this refuses to tell.
  const total = nftTotalCostWeiV1(candidate);
  const ceiling = intent.maxSpendWei === null ? null : BigInt(intent.maxSpendWei);
  const totalCost =
    total === null || ceiling === null || ceiling === BigInt(0)
      ? dimension('total_cost', null, 'insufficient_evidence', ['listing_order'])
      : dimension(
          'total_cost',
          Math.max(0, Math.min(100, 100 - Number((BigInt(total) * BigInt(100)) / ceiling))),
          null,
          [],
          Math.max(0, Math.round((input.now.getTime() - Date.parse(candidate.observedAt)) / 1000)),
        );

  // listing_freshness — how much of its life the observation has left, and how
  // long the order itself still stands.
  const observedAgeMs = input.now.getTime() - Date.parse(candidate.observedAt);
  const remainingMs = Date.parse(candidate.listingExpiresAt) - input.now.getTime();
  const freshness =
    Number.isNaN(observedAgeMs) || Number.isNaN(remainingMs)
      ? dimension('listing_freshness', null, 'insufficient_evidence', ['listing_order'])
      : remainingMs <= 0
        ? dimension('listing_freshness', 0, null, [], Math.round(observedAgeMs / 1000))
        : dimension(
            'listing_freshness',
            Math.max(0, Math.min(100, 100 - Math.round((observedAgeMs / NFT_LISTING_TTL_MS_DEFAULT_V1) * 100))),
            null,
            [],
            Math.round(observedAgeMs / 1000),
          );

  // route_simplicity — one call, no approvals, is the simplest shape this
  // product can produce, and the blueprint contract will not permit another.
  const simplicity = dimension(
    'route_simplicity',
    100,
    null,
    [],
    Math.max(0, Math.round((input.now.getTime() - Date.parse(candidate.observedAt)) / 1000)),
  );

  // contract_safety — no approved source exists. It says so, every time, in
  // the same words.
  const safety = dimension('contract_safety', null, 'no_approved_source', ['ownership_read']);

  const byName: Record<NftScoreDimensionNameV1, NftScoreDimensionV1> = {
    total_cost: totalCost,
    listing_freshness: freshness,
    route_simplicity: simplicity,
    contract_safety: safety,
  };
  return NFT_SCORE_DIMENSIONS_V1.map((name) => byName[name]);
}

// --- Route Card -------------------------------------------------------------

export type NftRouteCardBuildV1 =
  | { ok: true; card: NftRouteCardV1 }
  | { ok: false; reason: NftVerificationReasonV1; card: NftRouteCardV1 };

/**
 * The card, ready or not.
 *
 * A listing that fails verification still produces a card — a `failed` one,
 * carrying the reason. A removed or unbuyable listing that simply vanished
 * from the screen would leave the user wondering what happened to it.
 */
export function buildNftRouteCardV1(input: {
  intent: NftPurchaseIntentV1;
  asset: NftAssetRefV1;
  candidate: NftListingCandidateV1 | null;
  evidence: readonly NftEvidenceRecordV1[];
  failureReason: string | null;
  ttlMs?: number;
  now: Date;
}): NftRouteCardBuildV1 {
  const verification =
    input.candidate === null
      ? null
      : verifyNftListingV1({ intent: input.intent, candidate: input.candidate, now: input.now });
  const usable = input.candidate !== null && verification?.ok === true;

  const dimensions = usable
    ? scoreNftCandidateV1({
        intent: input.intent,
        candidate: input.candidate as NftListingCandidateV1,
        evidence: input.evidence,
        now: input.now,
      })
    : NFT_SCORE_DIMENSIONS_V1.map((name) =>
        buildDimensionV1({
          intent: input.intent,
          candidateHash: input.candidate?.candidateHash ?? ZERO_HASH_V1,
          dimension: name,
          score: null,
          notScoredReason: name === 'contract_safety' ? 'no_approved_source' : 'insufficient_evidence',
          sources: [],
          freshness: null,
          missingEvidence: ['listing_order'],
          now: input.now,
        }),
      );

  const reason =
    input.failureReason ??
    (verification && !verification.ok ? verification.reason : input.candidate === null ? 'no_active_listing' : null);

  const base = {
    ...stamp({ tenantId: input.intent.tenantId, walletAddress: input.intent.walletAddress, now: input.now }),
    schemaVersion: 'nft-route-card/v1' as const,
    id: `nft-route-card:${stableHashV1('nft-route-card', {
      intentHash: input.intent.intentHash,
      candidateHash: input.candidate?.candidateHash ?? null,
    }).slice(2, 26)}`,
    status: (usable ? 'ready' : 'failed') as 'ready' | 'failed',
    routeCardHash: ZERO_HASH_V1,
    intentHash: input.intent.intentHash,
    recommendation: NFT_RECOMMENDATION_COPY_V1,
    asset: input.asset,
    // A card that is not ready carries no candidate: presenting an unbuyable
    // listing beside a price invites a click that cannot succeed.
    candidate: usable ? input.candidate : null,
    dimensions,
    evidenceHashes: input.evidence.map((record) => record.evidenceHash),
    evidenceGaps: nftEvidenceGapsV1(input.evidence),
    maxSpendWei: input.intent.maxSpendWei ?? '0',
    totalCostWei: usable ? nftTotalCostWeiV1(input.candidate as NftListingCandidateV1) : null,
    failureReason: usable ? null : (reason ?? 'unknown'),
    expiresAt: new Date(input.now.getTime() + (input.ttlMs ?? NFT_LISTING_TTL_MS_DEFAULT_V1)).toISOString(),
  };
  const card = NftRouteCardV1Schema.parse({
    ...base,
    routeCardHash: hashNftRouteCardV1(base as unknown as NftRouteCardV1),
  });
  if (usable) return { ok: true, card };
  return { ok: false, reason: (verification && !verification.ok ? verification.reason : 'provider_invalid_response'), card };
}
