import type { B20ReaderV1 } from '@mioagent/b20-control';
import {
  readTokenizedStockReferenceV1,
  TOKENIZED_STOCK_REFERENCE_MAX_AGE_SECONDS_V1,
} from '@mioagent/rwa-dossier';
import type { OfficialAssetRepositoryV1 } from '@mioagent/route-storage';

import type { MarketRealityReferenceStateV1 } from './contracts.js';
import {
  REVIEWED_US_EQUITIES_CALENDAR_2026_V1,
  classifyMarketRealityReferenceV1,
  unknownMarketRealityReferenceV1,
} from './referenceSession.js';

/** Shared reviewed production adapter for API and background evidence writers. */
export function createReviewedMarketRealityReferenceAdapterV1(deps: {
  official: OfficialAssetRepositoryV1;
  reader: B20ReaderV1;
}) {
  let anchorOnce: ReturnType<B20ReaderV1['readBlockAnchor']> | null = null;
  return async (input: {
    tokenAddress: string;
    issuerId: 'coinbase' | 'dinari' | 'backed';
    now: Date;
  }): Promise<MarketRealityReferenceStateV1> => {
    const tokenAddress = input.tokenAddress.toLowerCase();
    if (input.issuerId !== 'coinbase') {
      return unknownMarketRealityReferenceV1({
        reasonCode: 'issuer_reference_not_reviewed',
        reason: `No reviewed ${input.issuerId} reference/session configuration is established.`,
        observedAt: input.now.toISOString(),
      });
    }
    let identity: Awaited<ReturnType<OfficialAssetRepositoryV1['officialIdentity']>>;
    try {
      identity = await deps.official.officialIdentity({ chainId: 8453, tokenAddress });
    } catch {
      return unknownMarketRealityReferenceV1({
        reasonCode: 'reference_read_failed',
        reason: 'The reviewed exact-address reference configuration could not be read.',
        observedAt: input.now.toISOString(),
      });
    }
    if (
      !identity ||
      identity.chainId !== 8453 ||
      identity.tokenAddress !== tokenAddress ||
      identity.issuer !== input.issuerId
    ) {
      return unknownMarketRealityReferenceV1({
        reasonCode: 'exact_representation_not_reviewed',
        reason: 'No reviewed Coinbase source binds this exact address to a reference.',
        observedAt: input.now.toISOString(),
      });
    }
    const listing = identity.listings.find(
      (row) =>
        row.sourceKind === 'base_docs_technical' &&
        row.currentlyListed &&
        row.referenceFeedAddress !== null,
    );
    if (!listing?.referenceFeedAddress) {
      return unknownMarketRealityReferenceV1({
        reasonCode: 'reference_configuration_missing',
        reason: 'The reviewed exact-address listing does not publish a reference address.',
        observedAt: input.now.toISOString(),
      });
    }
    const referenceAddress = listing.referenceFeedAddress.toLowerCase();
    let anchor: Awaited<ReturnType<B20ReaderV1['readBlockAnchor']>>;
    try {
      anchorOnce ??= deps.reader.readBlockAnchor();
      anchor = await anchorOnce;
    } catch {
      return unknownMarketRealityReferenceV1({
        reasonCode: 'reference_read_failed',
        reason: 'The Base reference block anchor could not be read.',
        observedAt: input.now.toISOString(),
        referenceSource: listing.sourceUrl,
        referenceAddress,
      });
    }
    if (!anchor.ok) {
      return unknownMarketRealityReferenceV1({
        reasonCode: 'reference_read_failed',
        reason: 'The Base reference block anchor could not be established.',
        observedAt: input.now.toISOString(),
        referenceSource: listing.sourceUrl,
        referenceAddress,
      });
    }
    let reference: Awaited<ReturnType<typeof readTokenizedStockReferenceV1>>;
    try {
      reference = await readTokenizedStockReferenceV1(deps.reader, {
        feedAddress: referenceAddress,
        anchor: anchor.value,
        now: input.now,
        // The listing above is Coinbase's own technical corpus, so the registry
        // is being asked about an address it documents.
        registryToken: tokenAddress,
        maxAgeSeconds: TOKENIZED_STOCK_REFERENCE_MAX_AGE_SECONDS_V1,
      });
    } catch {
      return unknownMarketRealityReferenceV1({
        reasonCode: 'reference_read_failed',
        reason: 'The reviewed reference provider call did not complete.',
        observedAt: input.now.toISOString(),
        referenceSource: listing.sourceUrl,
        referenceAddress,
      });
    }
    if (
      !['fresh', 'stale', 'paused'].includes(reference.status) ||
      reference.valueAtomic === null ||
      reference.decimals === null ||
      reference.feedUpdatedAt === null ||
      reference.evidence === null ||
      reference.evidence.blockNumber === null ||
      reference.evidence.blockHash === null ||
      reference.evidence.evidenceHash === null ||
      reference.evidence.targetAddress === null
    ) {
      return unknownMarketRealityReferenceV1({
        reasonCode:
          reference.status === 'invalid' ? 'reference_response_invalid' : 'reference_read_failed',
        reason:
          reference.status === 'invalid'
            ? 'The reviewed reference response failed structural validation.'
            : 'The reviewed reference source did not return a complete observation.',
        observedAt: input.now.toISOString(),
        referenceSource: listing.sourceUrl,
        referenceAddress,
      });
    }
    return classifyMarketRealityReferenceV1({
      now: input.now,
      configuration: {
        chainId: 8453,
        tokenAddress,
        issuerId: input.issuerId,
        referenceAddress,
        referenceSource: listing.sourceUrl,
        calendar: REVIEWED_US_EQUITIES_CALENDAR_2026_V1,
        outsideRegularHours: 'holds_last_close',
      },
      observation: {
        chainId: 8453,
        tokenAddress,
        issuerId: input.issuerId,
        referenceAddress: reference.feedAddress!,
        status:
          reference.registryPause === 'paused'
            ? 'corporate_action_hold'
            : reference.status === 'stale'
              ? 'stale'
              : 'fresh',
        valueAtomic: reference.valueAtomic,
        decimals: reference.decimals,
        observedAt: reference.evidence.observedAt,
        referenceUpdatedAt: reference.feedUpdatedAt,
        evidence: {
          kind: 'chainlink_feed',
          source: reference.evidence.source,
          blockNumber: reference.evidence.blockNumber,
          blockHash: reference.evidence.blockHash,
          targetAddress: reference.evidence.targetAddress,
          evidenceHash: reference.evidence.evidenceHash,
        },
      },
    });
  };
}
