import { stableHashV1 } from '@mioagent/route-domain';
import type {
  CashExitMeasurementRunV1,
  CashExitQuoteLegV1,
  CashExitSourceObservationV1,
  OfficialCashExitRepositoryV1,
  RepresentationRatioRepositoryV1,
  RepresentationRatioRowV1,
  RepresentationUnderlyingV1,
  UnderlyingAssetRepositoryV1,
} from '@mioagent/route-storage';

import {
  MarketRealityIndexV1Schema,
  MarketRealityQuestionV1Schema,
  MarketRealityResponseV1Schema,
  type MarketRealityDirectionV1,
  type MarketRealityReferenceStateV1,
  type MarketRealityIndexV1,
  type MarketRealityResponseV1,
} from './contracts.js';

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
// The production reader runs every six hours. One extra hour tolerates timer
// jitter without allowing yesterday's pre-corporate-action multiplier to
// normalize a fresh quote.
const RATIO_FRESHNESS_TTL_MS_V1 = 7 * 60 * 60 * 1_000;

export interface MarketRealityDepsV1 {
  underlyings: UnderlyingAssetRepositoryV1;
  cashExit: OfficialCashExitRepositoryV1;
  ratios: RepresentationRatioRepositoryV1;
  now: () => Date;
  reference?: (input: {
    tokenAddress: string;
    issuerId: 'coinbase' | 'dinari' | 'backed';
    now: Date;
  }) => Promise<MarketRealityReferenceStateV1>;
}

function unknownReferenceV1(): MarketRealityReferenceStateV1 {
  return {
    status: 'unknown',
    session: 'unknown',
    valueAtomic: null,
    decimals: null,
    observedAt: null,
    comparable: false,
    reason: 'No reviewed comparable reference/session adapter answered for this representation.',
  };
}

function quoteForDirectionV1(
  row: CashExitSourceObservationV1,
  direction: MarketRealityDirectionV1,
): CashExitQuoteLegV1 | null {
  return direction === 'buy' ? row.buyQuote : row.sellQuote;
}

function sourceStatusV1(
  row: CashExitSourceObservationV1,
  direction: MarketRealityDirectionV1,
  nowMs: number,
): 'quoted' | 'no_route' | 'measurement_failed' | 'not_measured' {
  if (Date.parse(row.expiresAt) <= nowMs) return 'not_measured';
  if (quoteForDirectionV1(row, direction)) return 'quoted';
  if (direction === 'buy' && row.errorCode === 'cash_size_anchor_no_route') return 'no_route';
  if (direction === 'sell' && ['buy_only', 'unavailable'].includes(row.status)) return 'no_route';
  return 'measurement_failed';
}

function normalizedExposureV1(input: {
  binding: RepresentationUnderlyingV1;
  tokenAtomic: string;
  tokenDecimals: number;
  ratio: RepresentationRatioRowV1 | null;
  nowMs: number;
}): {
  atomic: string | null;
  decimals: number | null;
  normalization: 'fresh_ratio_applied' | 'reviewed_token_already_applied' | 'not_established';
} {
  if (input.binding.representationKind === 'non_rebasing_erc4626_wrapper') {
    return { atomic: null, decimals: null, normalization: 'not_established' };
  }
  if (
    input.binding.representationKind === 'rebasing_erc20' &&
    ['dinari', 'backed'].includes(input.binding.issuerId ?? '')
  ) {
    return {
      atomic: input.tokenAtomic,
      decimals: input.tokenDecimals,
      normalization: 'reviewed_token_already_applied',
    };
  }
  const checkedAt = input.ratio ? Date.parse(input.ratio.lastCheckedAt) : Number.NaN;
  const ratioIsFresh =
    Number.isFinite(checkedAt) &&
    checkedAt <= input.nowMs &&
    input.nowMs - checkedAt <= RATIO_FRESHNESS_TTL_MS_V1;
  if (!input.ratio || input.ratio.application !== 'apply_to_raw_balance' || !ratioIsFresh) {
    return { atomic: null, decimals: null, normalization: 'not_established' };
  }
  return {
    atomic: (
      (BigInt(input.tokenAtomic) * BigInt(input.ratio.rawValue)) /
      BigInt(input.ratio.scale)
    ).toString(),
    decimals: input.tokenDecimals,
    normalization: 'fresh_ratio_applied',
  };
}

function effectivePriceV1(
  cashAtomic: string,
  exposureAtomic: string,
  exposureDecimals: number,
): string {
  return (
    (BigInt(cashAtomic) * 10n ** BigInt(exposureDecimals + 2)) /
    BigInt(exposureAtomic)
  ).toString();
}

function bestRowV1(
  rows: readonly CashExitSourceObservationV1[],
  direction: MarketRealityDirectionV1,
): CashExitSourceObservationV1 | null {
  return (
    rows
      .filter((row) => quoteForDirectionV1(row, direction) !== null)
      .sort((left, right) => {
        const l = quoteForDirectionV1(left, direction)!;
        const r = quoteForDirectionV1(right, direction)!;
        const lv = BigInt(l.outputAtomic);
        const rv = BigInt(r.outputAtomic);
        return lv === rv ? left.source.localeCompare(right.source) : lv > rv ? -1 : 1;
      })[0] ?? null
  );
}

function exactRowsV1(
  run: CashExitMeasurementRunV1 | null,
  requestedCashAtomic: string,
  destination: 'USDC' | 'ETH',
): CashExitSourceObservationV1[] {
  if (!run) return [];
  return run.observations.filter(
    (row) => row.requestedCashAtomic === requestedCashAtomic && row.destination === destination,
  );
}

export async function assembleMarketRealityV1(
  deps: MarketRealityDepsV1,
  input: {
    underlyingKey: string;
    direction: MarketRealityDirectionV1;
    requestedCashAtomic: string;
    destination?: 'USDC' | 'ETH';
  },
): Promise<MarketRealityResponseV1> {
  const now = deps.now();
  const question = MarketRealityQuestionV1Schema.parse({
    chainId: 8453,
    underlyingKey: input.underlyingKey,
    direction: input.direction,
    requestedCashAtomic: input.requestedCashAtomic,
    cashAsset: 'USDC',
    cashAddress: USDC,
    cashDecimals: 6,
    destination: input.destination ?? 'USDC',
    exactSizeOnly: true,
    baseOnly: true,
  });
  const bindings = await deps.underlyings.representationsOf({
    chainId: 8453,
    underlyingKey: question.underlyingKey,
  });
  const ratios = await deps.ratios.readRatios({
    chainId: 8453,
    tokenAddresses: bindings.map((row) => row.tokenAddress),
  });
  const ratioByAddress = new Map(ratios.map((row) => [row.tokenAddress, row]));
  const nowMs = now.getTime();

  const representations = await Promise.all(
    bindings.map(async (binding) => {
      const run = await deps.cashExit.latestCompletedRun({
        chainId: 8453,
        tokenAddress: binding.tokenAddress,
        scope: 'public_ladder',
      });
      const rows = exactRowsV1(run, question.requestedCashAtomic, question.destination);
      const sourceStates = rows.map((row) => ({
        row,
        status: sourceStatusV1(row, question.direction, nowMs),
      }));
      const best = bestRowV1(
        sourceStates.filter((item) => item.status === 'quoted').map((item) => item.row),
        question.direction,
      );
      const complete = Boolean(run) && rows.length === run!.approvedSources.length;
      const status = best
        ? ('full' as const)
        : !complete || sourceStates.some((item) => item.status === 'not_measured')
          ? ('not_measured' as const)
          : sourceStates.every((item) => item.status === 'no_route')
            ? ('unavailable' as const)
            : ('measurement_failed' as const);
      const quote = best ? quoteForDirectionV1(best, question.direction) : null;
      const tokenAtomic = best
        ? question.direction === 'buy'
          ? (best.buyQuote?.outputAtomic ?? null)
          : best.testedTokenAtomic
        : null;
      const normalized = tokenAtomic
        ? normalizedExposureV1({
            binding,
            tokenAtomic,
            tokenDecimals: best!.tokenDecimals,
            ratio: ratioByAddress.get(binding.tokenAddress) ?? null,
            nowMs,
          })
        : { atomic: null, decimals: null, normalization: 'not_established' as const };
      const returnedCashAtomic =
        best && question.direction === 'sell' && question.destination === 'USDC'
          ? (best.sellQuote?.outputAtomic ?? null)
          : best && question.direction === 'buy'
            ? (best.buyQuote?.inputAtomic ?? null)
            : null;
      const price =
        returnedCashAtomic && normalized.atomic && normalized.decimals !== null
          ? effectivePriceV1(returnedCashAtomic, normalized.atomic, normalized.decimals)
          : null;
      const reference = binding.issuerId
        ? await (deps.reference?.({
            tokenAddress: binding.tokenAddress,
            issuerId: binding.issuerId,
            now,
          }) ?? Promise.resolve(unknownReferenceV1()))
        : unknownReferenceV1();
      const premium =
        price && reference.comparable && reference.valueAtomic && reference.decimals === 8
          ? (
              ((BigInt(price) - BigInt(reference.valueAtomic)) * 10_000n) /
              BigInt(reference.valueAtomic)
            ).toString()
          : null;
      const routePolicyKey = run
        ? stableHashV1('market-reality-route-policy/v1', {
            chainId: 8453,
            approvedSources: [...run.approvedSources].sort(),
            destinations: [...run.destinations].sort(),
          })
        : null;
      return {
        tokenAddress: binding.tokenAddress,
        issuerId: binding.issuerId!,
        issuerInstrumentKey: binding.issuerInstrumentKey!,
        representationKind: binding.representationKind!,
        status,
        routePolicyKey,
        exactTestedTokenAtomic: tokenAtomic,
        normalizedExposureAtomic: normalized.atomic,
        normalizedExposureDecimals: normalized.decimals,
        normalization: normalized.normalization,
        returnedCashAtomic,
        effectivePriceAtomic: price,
        effectivePriceDecimals: price ? (8 as const) : null,
        premiumDiscountBps: premium,
        reference,
        sources: sourceStates.map(({ row, status: sourceStatus }) => {
          const sourceQuote = quoteForDirectionV1(row, question.direction);
          return {
            source: row.source,
            status: sourceStatus,
            errorCode: sourceStatus === 'quoted' ? null : row.errorCode,
            quoteEvidence: sourceQuote
              ? {
                  kind: 'router_quote' as const,
                  source: row.source,
                  direction: question.direction,
                  routeKey: sourceQuote.routeKey,
                  candidateHash: sourceQuote.candidateHash,
                  evidenceHash: sourceQuote.evidenceHash,
                  inputAtomic: sourceQuote.inputAtomic,
                  outputAtomic: sourceQuote.outputAtomic,
                  observedAt: sourceQuote.observedAt,
                  expiresAt: sourceQuote.expiresAt,
                  blockNumber: sourceQuote.blockNumber,
                }
              : null,
            simulationEvidence: {
              kind: 'route_simulation' as const,
              status: 'not_simulated' as const,
              evidenceHash: null,
            },
          };
        }),
        observedAt: quote?.observedAt ?? null,
        expiresAt: quote?.expiresAt ?? null,
      };
    }),
  );

  const routePolicies = new Set(
    representations
      .map((row) => row.routePolicyKey)
      .filter((value): value is `0x${string}` => value !== null),
  );
  const comparable = representations.filter(
    (row) =>
      row.status === 'full' &&
      row.normalizedExposureAtomic !== null &&
      row.effectivePriceAtomic !== null &&
      row.routePolicyKey !== null,
  );
  const coverageComplete =
    representations.length >= 2 &&
    comparable.length === representations.length &&
    routePolicies.size === 1;
  const ordered = coverageComplete
    ? [...comparable]
        .sort((left, right) => {
          const l = BigInt(left.effectivePriceAtomic!);
          const r = BigInt(right.effectivePriceAtomic!);
          const buyOrder =
            question.direction === 'buy'
              ? l < r
                ? -1
                : l > r
                  ? 1
                  : 0
              : l > r
                ? -1
                : l < r
                  ? 1
                  : 0;
          return buyOrder || left.tokenAddress.localeCompare(right.tokenAddress);
        })
        .map((row) => row.tokenAddress)
    : [];
  return MarketRealityResponseV1Schema.parse({
    schemaVersion: 'market-reality/v1',
    question,
    coverage: {
      policy: 'same_approved_router_set_exact_size_and_destination',
      reviewedRepresentations: representations.length,
      comparableRepresentations: comparable.length,
      status: coverageComplete ? 'complete' : 'incomplete',
      reason: coverageComplete
        ? null
        : representations.length < 2
          ? 'Fewer than two reviewed exact-address representations are bound to this underlying.'
          : 'Every reviewed representation must have fresh exact-size evidence, normalized exposure and the same approved-router policy.',
    },
    ranking: {
      status: coverageComplete ? 'available' : 'withheld',
      orderedTokenAddresses: ordered,
      reason: coverageComplete
        ? null
        : 'Coverage comparability did not pass; no BEST representation is emitted.',
    },
    quoteEvidenceIsExecutionProof: false,
    representations,
    assembledAt: now.toISOString(),
  });
}

/**
 * The chooser's read: every reviewed underlying, most-represented first.
 *
 * A projection rather than a query, so both repositories produce the same
 * ordering and the same `multiIssuer` rule. That flag is the one derived value
 * here and it is derived from the ISSUER set, never from the count: a rebasing
 * token and its own wrapper are two representations of one issuer's structure
 * choice, and calling that "two issuers" would promise a comparison that has
 * nothing on the other side of it.
 */
export async function assembleMarketRealityIndexV1(
  deps: Pick<MarketRealityDepsV1, 'underlyings' | 'now'>,
  input: { limit: number },
): Promise<MarketRealityIndexV1> {
  const rows = await deps.underlyings.listUnderlyings({ chainId: 8453, limit: input.limit });
  const counts = await deps.underlyings.underlyingCounts({ chainId: 8453 });
  const entries = rows.map((row) => ({
    underlyingKey: row.underlying.underlyingKey,
    canonicalName: row.underlying.canonicalName,
    displaySymbol: row.underlying.displaySymbol ?? null,
    assetClass: row.underlying.assetClass,
    identifierScheme: row.underlying.identifierScheme ?? null,
    identifierValue: row.underlying.identifierValue ?? null,
    representationCount: row.representationCount,
    issuerIds: row.issuerIds,
    multiIssuer: row.issuerIds.length > 1,
  }));
  return MarketRealityIndexV1Schema.parse({
    schemaVersion: 'market-reality-index/v1',
    chainId: 8453,
    entries,
    totals: {
      underlyings: counts.underlyings,
      boundRepresentations: counts.boundRepresentations,
      multiIssuerUnderlyings: counts.multiIssuerUnderlyings,
    },
    observedAt: deps.now().toISOString(),
  });
}
