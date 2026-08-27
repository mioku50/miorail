import { stableHashV1 } from '@mioagent/route-domain';
import {
  MarketRealityEvidenceSnapshotV1Schema,
  hashMarketRealityEvidenceSnapshotV1,
  type CashExitMeasurementRunV1,
  type CashExitSourceObservationV1,
  type MarketRealityEvidenceSnapshotV1,
  type MarketRealityReferenceStateV1,
  type RepresentationRatioRepositoryV1,
  type RepresentationSupplyRepositoryV1,
  type UnderlyingAssetRepositoryV1,
} from '@mioagent/route-storage';

import { evaluateMarketRealityBasisV1 } from './basis.js';
import { effectivePriceV1, normalizedExposureV1, supplyEvidenceV1 } from './engine.js';
import { unknownMarketRealityReferenceV1 } from './referenceSession.js';

export interface MarketRealityEvidenceCaptureDepsV1 {
  underlyings: UnderlyingAssetRepositoryV1;
  ratios: RepresentationRatioRepositoryV1;
  supplies: RepresentationSupplyRepositoryV1;
  now: () => Date;
  reference: (input: {
    tokenAddress: string;
    issuerId: 'coinbase' | 'dinari' | 'backed';
    now: Date;
  }) => Promise<MarketRealityReferenceStateV1>;
}

function marketStatusV1(
  row: CashExitSourceObservationV1,
  direction: 'buy' | 'sell',
): 'quoted' | 'no_route' | 'unsized' | 'measurement_failed' {
  if (direction === 'buy' ? row.buyQuote : row.sellQuote) return 'quoted';
  if (row.errorCode === 'cash_size_anchor_no_route') {
    return direction === 'buy' ? 'no_route' : 'unsized';
  }
  if (direction === 'sell' && ['buy_only', 'unavailable'].includes(row.status)) {
    return 'no_route';
  }
  return 'measurement_failed';
}

/**
 * Capture factory used at the write boundary of a NEW cash-exit run.
 *
 * It reads each mutable fact once, embeds the result beside the immutable
 * router observation and returns only hash-validated snapshots. History reads
 * this payload later; they never call this function and therefore cannot
 * reconstruct old points from today's feed, ratio, supply or calendar.
 */
export function createMarketRealityEvidenceCaptureV1(
  deps: MarketRealityEvidenceCaptureDepsV1,
): (run: CashExitMeasurementRunV1) => Promise<MarketRealityEvidenceSnapshotV1[]> {
  return async (run) => {
    const capturedAtDate = deps.now();
    const capturedAt = capturedAtDate.toISOString();
    const [underlying, ratios, supplies] = await Promise.all([
      deps.underlyings.underlyingOf({ chainId: 8453, tokenAddress: run.tokenAddress }),
      deps.ratios.readRatios({ chainId: 8453, tokenAddresses: [run.tokenAddress] }),
      deps.supplies.readSupplies({ chainId: 8453, tokenAddresses: [run.tokenAddress] }),
    ]);
    const binding = underlying?.binding ?? null;
    const ratio = ratios.find((row) => row.tokenAddress === run.tokenAddress) ?? null;
    const supply = supplyEvidenceV1(
      supplies.find((row) => row.tokenAddress === run.tokenAddress) ?? null,
      capturedAtDate.getTime(),
    );
    const reference =
      binding?.issuerId && binding.issuerInstrumentKey && binding.representationKind
        ? await deps.reference({
            tokenAddress: run.tokenAddress,
            issuerId: binding.issuerId,
            now: capturedAtDate,
          })
        : unknownMarketRealityReferenceV1({
            reasonCode: 'exact_representation_not_reviewed',
            reason:
              'No complete reviewed underlying/issuer binding exists for this exact representation.',
            observedAt: capturedAt,
          });
    const routePolicyKey = stableHashV1('market-reality-route-policy/v1', {
      chainId: 8453,
      approvedSources: [...run.approvedSources].sort(),
      destinations: [...run.destinations].sort(),
    });

    return run.observations.flatMap((observation) =>
      (['buy', 'sell'] as const).map((direction) => {
        const quote = direction === 'buy' ? observation.buyQuote : observation.sellQuote;
        const tokenAtomic = quote
          ? direction === 'buy'
            ? quote.outputAtomic
            : observation.testedTokenAtomic
          : null;
        const normalized =
          binding && tokenAtomic
            ? normalizedExposureV1({
                binding,
                tokenAtomic,
                tokenDecimals: observation.tokenDecimals,
                ratio,
                nowMs: capturedAtDate.getTime(),
              })
            : { atomic: null, decimals: null, normalization: 'not_established' as const };
        const cashAtomic = quote
          ? direction === 'buy'
            ? quote.inputAtomic
            : observation.destination === 'USDC'
              ? quote.outputAtomic
              : null
          : null;
        const effectivePrice =
          cashAtomic && normalized.atomic && normalized.decimals !== null
            ? effectivePriceV1(cashAtomic, normalized.atomic, normalized.decimals)
            : null;
        const marketStatus = marketStatusV1(observation, direction);
        const marketObservedAt = quote?.observedAt ?? observation.observedAt;
        const marketExpiresAt = quote?.expiresAt ?? observation.expiresAt;
        const basis = evaluateMarketRealityBasisV1({
          issuerId: binding?.issuerId ?? null,
          marketStatus,
          quoteObservedAt: marketObservedAt,
          quoteExpiresAt: marketExpiresAt,
          evaluatedAt: capturedAt,
          normalizedExposureAtomic: normalized.atomic,
          effectivePriceAtomic: effectivePrice,
          effectivePriceDecimals: effectivePrice ? 8 : null,
          supplyState: supply.state,
          reference,
        });
        const content: Omit<MarketRealityEvidenceSnapshotV1, 'snapshotHash'> = {
          schemaVersion: 'market-reality-evidence-snapshot/v1',
          runId: run.runId,
          observationHash: observation.observationHash,
          chainId: 8453,
          tokenAddress: run.tokenAddress,
          issuerId: binding?.issuerId ?? null,
          issuerInstrumentKey: binding?.issuerInstrumentKey ?? null,
          representationKind: binding?.representationKind ?? null,
          direction,
          requestedCashAtomic: observation.requestedCashAtomic,
          requestedTokenAtomic: observation.requestedTokenAtomic,
          testedTokenAtomic: observation.testedTokenAtomic,
          destination: observation.destination,
          destinationAddress: observation.destinationAddress,
          destinationDecimals: observation.destinationDecimals,
          source: observation.source,
          approvedSources: [...run.approvedSources].sort(),
          routePolicyKey,
          marketStatus,
          marketObservedAt,
          marketExpiresAt,
          normalizedExposureAtomic: normalized.atomic,
          normalizedExposureDecimals: normalized.decimals,
          normalization: normalized.normalization,
          ratio: ratio
            ? {
                ratioKind: ratio.ratioKind,
                application: ratio.application,
                rawValue: ratio.rawValue,
                scale: ratio.scale,
                scaleSource: ratio.scaleSource,
                blockNumber: ratio.blockNumber,
                blockHash: ratio.blockHash,
                evidenceHash: ratio.evidenceHash,
                observedAt: ratio.observedAt,
                lastCheckedAt: ratio.lastCheckedAt,
              }
            : null,
          supply: {
            state: supply.state,
            totalSupplyAtomic: supply.totalSupplyAtomic,
            decimals: supply.decimals,
            blockNumber: supply.blockNumber,
            blockHash: supply.blockHash,
            evidenceHash: supply.evidenceHash,
            observedAt: supply.observedAt,
            readOutcome: supply.readOutcome,
          },
          effectivePriceAtomic: effectivePrice,
          effectivePriceDecimals: effectivePrice ? 8 : null,
          reference,
          basis,
          capturedAt,
        };
        return MarketRealityEvidenceSnapshotV1Schema.parse({
          ...content,
          snapshotHash: hashMarketRealityEvidenceSnapshotV1(content),
        });
      }),
    );
  };
}
