import { stableHashV1 } from '@mioagent/route-domain';
import type {
  CashExitMeasurementRunV1,
  CashExitQuoteLegV1,
  CashExitSourceObservationV1,
  OfficialCashExitRepositoryV1,
  RepresentationRatioRepositoryV1,
  RepresentationRatioRowV1,
  RepresentationSupplyRepositoryV1,
  RepresentationSupplyRowV1,
  RepresentationUnderlyingV1,
  UnderlyingAssetRepositoryV1,
} from '@mioagent/route-storage';

import {
  MarketRealityIndexV1Schema,
  MarketRealityQuestionV1Schema,
  MarketRealityResponseV2Schema,
  type MarketRealityDirectionV1,
  type MarketRealityLivenessV1,
  type MarketRealityObservationV2,
  type MarketRealityReferenceStateV1,
  type MarketRealityIndexV1,
  type MarketRealityIndexScopeV1,
  type MarketRealityResponseV2,
} from './contracts.js';
import { canonicalReviewedBindingV1 } from './canonicalBinding.js';
import { unknownMarketRealityReferenceV1 } from './referenceSession.js';
import { evaluateMarketRealityBasisV1 } from './basis.js';

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
// The production reader runs every six hours. One extra hour tolerates timer
// jitter without allowing yesterday's pre-corporate-action multiplier to
// normalize a fresh quote.
const RATIO_FRESHNESS_TTL_MS_V1 = 7 * 60 * 60 * 1_000;
const SUPPLY_FRESHNESS_TTL_MS_V1 = 7 * 60 * 60 * 1_000;

export interface MarketRealityDepsV1 {
  underlyings: UnderlyingAssetRepositoryV1;
  cashExit: OfficialCashExitRepositoryV1;
  ratios: RepresentationRatioRepositoryV1;
  supplies: RepresentationSupplyRepositoryV1;
  now: () => Date;
  reference?: (input: {
    tokenAddress: string;
    issuerId: 'coinbase' | 'dinari' | 'backed';
    now: Date;
  }) => Promise<MarketRealityReferenceStateV1>;
}

function unknownReferenceV1(): MarketRealityReferenceStateV1 {
  return unknownMarketRealityReferenceV1({
    reasonCode: 'reference_adapter_not_configured',
    reason: 'No reviewed reference/session adapter answered for this exact representation.',
  });
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
): 'quoted' | 'no_route' | 'unsized' | 'measurement_failed' | 'not_measured' {
  if (Date.parse(row.expiresAt) <= nowMs) return 'not_measured';
  if (quoteForDirectionV1(row, direction)) return 'quoted';
  if (direction === 'buy' && row.errorCode === 'cash_size_anchor_no_route') return 'no_route';
  if (direction === 'sell' && row.errorCode === 'cash_size_anchor_no_route') return 'unsized';
  if (direction === 'sell' && ['buy_only', 'unavailable'].includes(row.status)) return 'no_route';
  return 'measurement_failed';
}

export function supplyEvidenceV1(row: RepresentationSupplyRowV1 | null, nowMs: number) {
  if (!row) {
    return {
      state: 'supply_unknown' as const,
      totalSupplyAtomic: null,
      decimals: null,
      normalization: 'raw_erc20_total_supply' as const,
      blockNumber: null,
      blockHash: null,
      observedAt: null,
      evidenceHash: null,
      source: 'erc20_total_supply' as const,
      readOutcome: 'not_observed' as const,
      fresh: false,
      reason: 'No exact-address totalSupply observation has been stored.',
    };
  }
  const observedMs = Date.parse(row.observedAt);
  const fresh =
    row.readOutcome === 'success' &&
    Number.isFinite(observedMs) &&
    observedMs <= nowMs &&
    nowMs - observedMs <= SUPPLY_FRESHNESS_TTL_MS_V1;
  const state = fresh ? row.state : ('supply_unknown' as const);
  return {
    state,
    totalSupplyAtomic: row.totalSupplyAtomic,
    decimals: row.decimals,
    normalization: 'raw_erc20_total_supply' as const,
    blockNumber: row.blockNumber,
    blockHash: row.blockHash,
    observedAt: row.observedAt,
    evidenceHash: row.evidenceHash,
    source: 'erc20_total_supply' as const,
    readOutcome: row.readOutcome,
    fresh,
    reason:
      state !== 'supply_unknown'
        ? null
        : row.readOutcome !== 'success'
          ? `The latest totalSupply read did not establish a value (${row.failureCode ?? row.readOutcome}).`
          : 'The latest successful totalSupply observation is outside the current comparison window.',
  };
}

export function normalizedExposureV1(input: {
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

export function effectivePriceV1(
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

/**
 * The newest observation for this exact question, whatever its age.
 *
 * History. The background sampler produces one of these every time it runs, and
 * it is never a current price — the caller must place it in `lastObservation`
 * and nowhere else.
 *
 * "Newest" is by `observedAt` across sources, with the source name breaking a
 * tie so the same run always yields the same row.
 */
function latestObservationV1(
  rows: readonly CashExitSourceObservationV1[],
  direction: MarketRealityDirectionV1,
  nowMs: number,
): MarketRealityObservationV2 | null {
  const observed = rows
    .map((row) => {
      const quote = quoteForDirectionV1(row, direction);
      const observedAt = quote?.observedAt ?? row.observedAt;
      return { row, quote, observedAt };
    })
    .filter((item) => Number.isFinite(Date.parse(item.observedAt)))
    .sort(
      (left, right) =>
        Date.parse(right.observedAt) - Date.parse(left.observedAt) ||
        left.row.source.localeCompare(right.row.source),
    );
  const newest = observed[0];
  if (!newest) return null;
  const expiresAt = newest.quote?.expiresAt ?? newest.row.expiresAt;
  return {
    source: newest.row.source,
    // A row that carried a quote WAS quoted, however long ago. Reporting it as
    // `not_measured` because time passed is the collapse this field exists to
    // undo.
    status: newest.quote
      ? 'quoted'
      : newest.row.errorCode === 'cash_size_anchor_no_route'
        ? direction === 'buy'
          ? 'no_route'
          : 'unsized'
        : ['buy_only', 'unavailable'].includes(newest.row.status)
          ? 'no_route'
          : 'measurement_failed',
    errorCode: newest.row.errorCode ?? null,
    observedAt: newest.observedAt,
    expiresAt,
    returnedCashAtomic:
      direction === 'sell'
        ? (newest.row.sellQuote?.outputAtomic ?? null)
        : (newest.row.buyQuote?.inputAtomic ?? null),
    open: Date.parse(expiresAt) > nowMs,
  };
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

function lastObservationRowV1(
  rows: readonly CashExitSourceObservationV1[],
): CashExitSourceObservationV1 | null {
  return (
    [...rows].sort(
      (left, right) =>
        Date.parse(right.observedAt) - Date.parse(left.observedAt) ||
        left.source.localeCompare(right.source),
    )[0] ?? null
  );
}

function lastObservationTimeV1(rows: readonly CashExitSourceObservationV1[]): string | null {
  return lastObservationRowV1(rows)?.observedAt ?? null;
}

function lastObservationExpiryV1(rows: readonly CashExitSourceObservationV1[]): string | null {
  return lastObservationRowV1(rows)?.expiresAt ?? null;
}

export async function assembleMarketRealityV2(
  deps: MarketRealityDepsV1,
  input: {
    underlyingKey: string;
    direction: MarketRealityDirectionV1;
    requestedCashAtomic: string;
    destination?: 'USDC' | 'ETH';
  },
): Promise<MarketRealityResponseV2> {
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
  const supplies = await deps.supplies.readSupplies({
    chainId: 8453,
    tokenAddresses: bindings.map((row) => row.tokenAddress),
  });
  const supplyByAddress = new Map(supplies.map((row) => [row.tokenAddress, row]));
  const nowMs = now.getTime();

  // Issuer typing is completed from the exact address before anything reads it,
  // so a pre-0059 row answers instead of throwing and `market-reality/v2` stays
  // strict. A binding whose structure cannot be established leaves the array
  // rather than entering it with an invented one; the coverage reason below
  // says so, and `reviewedRepresentationCount` still counts every reviewed row
  // Miorail holds, so the difference is visible rather than silent.
  const canonical = bindings.map((row) =>
    canonicalReviewedBindingV1(row, ratioByAddress.get(row.tokenAddress) ?? null),
  );
  const uncanonical = canonical.filter((row) => row.status === 'refused');
  const usableBindings = canonical.flatMap((row) =>
    row.status === 'canonical' ? [row.binding] : [],
  );

  const representations = await Promise.all(
    usableBindings.map(async (binding) => {
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
      // Keep the newest closed quote available only to explain why basis is
      // withheld. It must never populate the current-price fields below.
      const basisEvidenceRow = best ?? bestRowV1(rows, question.direction);
      const basisEvidenceQuote = basisEvidenceRow
        ? quoteForDirectionV1(basisEvidenceRow, question.direction)
        : null;
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
      const supply = supplyEvidenceV1(supplyByAddress.get(binding.tokenAddress) ?? null, nowMs);
      const lastObservation = latestObservationV1(rows, question.direction, nowMs);
      const basisMarketStatus = basisEvidenceQuote
        ? ('quoted' as const)
        : lastObservation?.status === 'unsized' ||
            sourceStates.some((item) => item.status === 'unsized')
          ? ('unsized' as const)
          : lastObservation?.status === 'no_route' ||
              (sourceStates.length > 0 && sourceStates.every((item) => item.status === 'no_route'))
            ? ('no_route' as const)
            : ('measurement_failed' as const);
      const basis = evaluateMarketRealityBasisV1({
        issuerId: binding.issuerId ?? null,
        marketStatus: basisMarketStatus,
        quoteObservedAt:
          basisEvidenceQuote?.observedAt ?? lastObservationTimeV1(rows) ?? now.toISOString(),
        quoteExpiresAt:
          basisEvidenceQuote?.expiresAt ?? lastObservationExpiryV1(rows) ?? now.toISOString(),
        evaluatedAt: now.toISOString(),
        normalizedExposureAtomic: normalized.atomic,
        effectivePriceAtomic: price,
        effectivePriceDecimals: price ? 8 : null,
        supplyState: supply.state,
        reference,
      });
      const routePolicyKey = run
        ? stableHashV1('market-reality-route-policy/v1', {
            chainId: 8453,
            approvedSources: [...run.approvedSources].sort(),
            destinations: [...run.destinations].sort(),
          })
        : null;
      const liveness: MarketRealityLivenessV1 =
        lastObservation === null
          ? 'never_measured'
          : sourceStates.some((item) => item.status !== 'not_measured')
            ? 'live'
            : 'history_only';
      return {
        tokenAddress: binding.tokenAddress,
        issuerId: binding.issuerId,
        issuerInstrumentKey: binding.issuerInstrumentKey,
        representationKind: binding.representationKind,
        supply,
        status,
        routePolicyKey,
        exactTestedTokenAtomic: tokenAtomic,
        normalizedExposureAtomic: normalized.atomic,
        normalizedExposureDecimals: normalized.decimals,
        normalization: normalized.normalization,
        returnedCashAtomic,
        effectivePriceAtomic: price,
        effectivePriceDecimals: price ? (8 as const) : null,
        premiumDiscountBps: basis.premiumDiscountBps,
        reference,
        basis,
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
                  // Already on the stored quote. The venue that held the money
                  // was measured from the first run and reported as nothing but
                  // the aggregator's name.
                  liquiditySources: sourceQuote.liquiditySources ?? [],
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
        liveness,
        lastObservation,
      };
    }),
  );

  const positiveSupply = representations.filter((row) => row.supply.state === 'positive_supply');
  const zeroSupply = representations.filter((row) => row.supply.state === 'zero_supply');
  const unresolvedSupply = representations.filter((row) => row.supply.state === 'supply_unknown');
  const routePolicies = new Set(
    positiveSupply
      .map((row) => row.routePolicyKey)
      .filter((value): value is `0x${string}` => value !== null),
  );
  const establishedMarketOutcomes = positiveSupply.filter(
    (row) => ['full', 'unavailable'].includes(row.status) && row.routePolicyKey !== null,
  );
  const comparable = positiveSupply.filter(
    (row) =>
      row.status === 'full' &&
      row.normalizedExposureAtomic !== null &&
      row.effectivePriceAtomic !== null &&
      row.routePolicyKey !== null,
  );
  const uncanonicalReason =
    uncanonical.length === 0
      ? null
      : `${uncanonical.length} reviewed representation${
          uncanonical.length === 1 ? '' : 's'
        } could not be placed in this comparison because the structure of the exact address is not established. Miorail did not guess one.`;
  const marketOutcomeComplete =
    uncanonical.length === 0 &&
    unresolvedSupply.length === 0 &&
    positiveSupply.length > 0 &&
    establishedMarketOutcomes.length === positiveSupply.length &&
    routePolicies.size === 1;
  const numericComparisonComplete =
    uncanonical.length === 0 &&
    unresolvedSupply.length === 0 &&
    positiveSupply.length >= 2 &&
    comparable.length === positiveSupply.length &&
    routePolicies.size === 1;
  return MarketRealityResponseV2Schema.parse({
    schemaVersion: 'market-reality/v2',
    question,
    universe: {
      // Every reviewed row, including one that could not be canonicalized. A
      // count that dropped with the array would hide the row instead of
      // reporting it.
      reviewedRepresentationCount: bindings.length,
      positiveSupplyRepresentationCount: positiveSupply.length,
      zeroSupplyRepresentationCount: zeroSupply.length,
      unresolvedSupplyRepresentationCount: unresolvedSupply.length,
    },
    marketOutcomeCoverage: {
      policy: 'same_reviewed_router_policy_exact_size_direction_and_destination',
      eligibleRepresentationCount: positiveSupply.length,
      establishedOutcomeCount: establishedMarketOutcomes.length,
      status: marketOutcomeComplete ? 'complete' : 'incomplete',
      reason: marketOutcomeComplete
        ? null
        : uncanonicalReason !== null
          ? uncanonicalReason
          : unresolvedSupply.length > 0
            ? 'Supply is unresolved for one or more reviewed representations; none may be silently removed from the denominator.'
            : positiveSupply.length === 0
              ? 'No reviewed representation has fresh evidence of outstanding supply.'
              : 'Every positive-supply representation must have a fresh exact-direction outcome under the same reviewed router policy.',
    },
    numericComparisonCoverage: {
      policy: 'fresh_numeric_quotes_same_exact_question_and_normalization',
      eligibleRepresentationCount: positiveSupply.length,
      pricedRepresentationCount: comparable.length,
      status: numericComparisonComplete ? 'complete' : 'incomplete',
      reason: numericComparisonComplete
        ? null
        : (uncanonicalReason ??
          'Every positive-supply representation needs a fresh normalized numeric quote for this exact question before numeric comparison is complete.'),
    },
    ranking: {
      status: 'withheld',
      policy: 'withheld_phase_10b8',
      orderedTokenAddresses: [],
      reason: numericComparisonComplete
        ? 'Numeric comparison coverage is complete, but Phase 10B.8 policy still withholds ranking and BEST.'
        : 'Numeric comparison coverage is incomplete; no BEST representation is emitted.',
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
  input: { limit: number; scope?: MarketRealityIndexScopeV1 },
): Promise<MarketRealityIndexV1> {
  // This endpoint backs the consumer `Stocks` screen, not a generic securities
  // catalogue. Pull the bounded full reviewed corpus first so an `unknown` or
  // bond/fund row cannot consume a page slot ahead of a later equity. Asset
  // class comes from reviewed identity evidence; labels never select it.
  const reviewedRows = await deps.underlyings.listUnderlyings({ chainId: 8453, limit: 500 });
  const stockRows = reviewedRows.filter((row) => row.underlying.assetClass === 'equity');
  // The default scope, and why it is not a preference.
  //
  // Three issuers put representations of the same securities on Base and they
  // are not three versions of one thing: B20 is the standard Base documents,
  // Backed bTokens are Swiss-law tracker certificates that rebase, and Dinari
  // dShares are a separate system again. Measured at $1,000 SELL on
  // 2026-09-04, 10 of 13 Coinbase representations hold a cash route, 2 of 21
  // Backed, and 0 of 96 Dinari — so 74% of the corpus was filling the first
  // screen with contracts that cannot answer the question the screen asks.
  //
  // They are not removed. `all_representations` returns exactly what this
  // surface returned before, and the multi-issuer comparison — the same
  // security, different representations, different market reality — is the one
  // thing here that nothing else shows. It just stops being the opening move.
  const scope: MarketRealityIndexScopeV1 = input.scope ?? 'coinbase_b20';
  const scopedRows =
    scope === 'coinbase_b20'
      ? stockRows.filter((row) => row.issuerIds.includes('coinbase'))
      : stockRows;
  const rows = scopedRows.slice(0, Math.max(1, Math.min(500, input.limit)));
  const entries = rows.map((row) => ({
    underlyingKey: row.underlying.underlyingKey,
    canonicalName: row.underlying.canonicalName,
    displaySymbol: row.underlying.displaySymbol ?? null,
    assetClass: row.underlying.assetClass,
    identifierScheme: row.underlying.identifierScheme ?? null,
    identifierValue: row.underlying.identifierValue ?? null,
    representationCount: row.representationCount,
    liveRepresentationCount: row.liveRepresentationCount,
    issuerIds: row.issuerIds,
    multiIssuer: row.issuerIds.length > 1,
    coinbaseIssued: row.issuerIds.includes('coinbase'),
  }));
  return MarketRealityIndexV1Schema.parse({
    schemaVersion: 'market-reality-index/v1',
    chainId: 8453,
    scope,
    entries,
    totals: {
      // Scoped, because these three sit above a scoped grid and a total that
      // did not move with the filter would describe a different page.
      underlyings: scopedRows.length,
      // In the Coinbase scope this counts COINBASE contracts, not every
      // contract bound to a Coinbase-covered company. The band read
      // "13 securities" beside "39 representations", and the 39 were mostly
      // Backed and Dinari addresses that the scope had just moved off the page
      // — two numbers, two units, one heading, and no way for a reader to tell
      // which was which.
      boundRepresentations: scopedRows.reduce(
        (total, row) =>
          total +
          (scope === 'coinbase_b20'
            ? (row.representationCountsByIssuer?.coinbase ?? 0)
            : row.representationCount),
        0,
      ),
      multiIssuerUnderlyings: scopedRows.filter((row) => row.issuerIds.length > 1).length,
      // Corpus-wide, always: what the other scope holds, so the filter can say
      // what it is hiding rather than hide it silently.
      coinbaseUnderlyings: stockRows.filter((row) => row.issuerIds.includes('coinbase')).length,
      allUnderlyings: stockRows.length,
    },
    observedAt: deps.now().toISOString(),
  });
}
