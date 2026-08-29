import {
  MarketRealityHistoryV1Schema,
  MarketRealityResponseV2Schema,
  type MarketRealityHistoryV1,
  type MarketRealityResponseV2,
} from '@mioagent/rwa-market-reality/contracts';

// ---------------------------------------------------------------------------
// The benchmark corpus: ten typed states a Stocks answer has to survive.
//
// Every fixture is parsed through the shipped contracts, so a case that could
// not exist in production cannot exist here either — the schemas refuse a
// representation with an observation and no liveness, a comparable basis with
// no bps, a fresh reference with no calendar. That is the whole reason to
// build the corpus from the contracts rather than from hand-written JSON: the
// benchmark's truth is the product's truth, and it goes stale the moment a
// contract changes rather than quietly measuring a shape nobody ships.
//
// No figure here came from a model. Each one is either a value the production
// pipeline produces or an exact refusal it is capable of.
// ---------------------------------------------------------------------------

const NOW = '2026-08-29T18:00:00.000Z';
export const STOCKS_BENCH_NOW_V1 = new Date(NOW);

const COINBASE_NVDA = '0xb20000000000000000000078ee7ce2fe4908108c';
const BACKED_NVDA = '0xa34c5e0abe843e10461e2c9586ea03e55dbcc495';
const BACKED_WRAPPER = '0x7e8101a1c322d394b3961498c7d40d2dfa94c392';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const REFERENCE_FEED = '0x1c2c7a4b1f3d6e5a8b9c0d1e2f30415263748596';
const UNDERLYING = 'security:isin:US67066G1040';
const POLICY = `0x${'b5'.repeat(32)}`;
const HASH_A = `0x${'11'.repeat(32)}`;
const HASH_B = `0x${'22'.repeat(32)}`;
const HASH_C = `0x${'33'.repeat(32)}`;

type SupplyState = 'positive_supply' | 'zero_supply' | 'supply_unknown';

function supply(state: SupplyState, readOutcome: 'success' | 'rpc_failure' = 'success') {
  const established = state !== 'supply_unknown';
  return {
    state,
    totalSupplyAtomic: established ? (state === 'zero_supply' ? '0' : '4820000000000000000000') : null,
    decimals: established ? 18 : null,
    normalization: 'raw_erc20_total_supply' as const,
    blockNumber: established ? '50612000' : null,
    blockHash: established ? HASH_A : null,
    observedAt: established ? '2026-08-29T17:58:00.000Z' : null,
    evidenceHash: established ? HASH_A : null,
    source: 'erc20_total_supply' as const,
    readOutcome: established ? ('success' as const) : readOutcome,
    fresh: established,
    reason: established ? null : 'The exact-address supply read did not return.',
  };
}

const CALENDAR = {
  key: 'nyse-2026-08-29',
  sourceUrls: ['https://www.nyse.com/markets/hours-calendars'],
  timeZone: 'America/New_York' as const,
  localDate: '2026-08-29',
  regularOpenMinute: 570,
  regularCloseMinute: 960,
  publicationSessionLocalDate: '2026-08-29',
  publicationSessionOpenMinute: 570,
  publicationSessionCloseMinute: 960,
};

function referenceEstablished() {
  return {
    status: 'fresh' as const,
    session: 'regular_hours' as const,
    marketSession: 'regular_hours' as const,
    publicationMode: 'live_reference' as const,
    valueAtomic: '17845000000',
    decimals: 8,
    observedAt: '2026-08-29T17:59:30.000Z',
    referenceUpdatedAt: '2026-08-29T17:59:00.000Z',
    freshness: 'fresh' as const,
    referenceSource: 'reviewed equity reference feed',
    referenceAddress: REFERENCE_FEED,
    calendar: CALENDAR,
    evidence: {
      kind: 'chainlink_feed' as const,
      source: 'reviewed equity reference feed',
      blockNumber: '50612000',
      blockHash: HASH_A,
      targetAddress: REFERENCE_FEED,
      evidenceHash: HASH_B,
    },
    comparable: false as const,
    reasonCode: 'reviewed_calendar_regular_hours' as const,
    reason: null,
  };
}

function referenceUnknown(reasonCode: 'issuer_reference_not_reviewed' | 'reference_adapter_not_configured') {
  return {
    status: 'unknown' as const,
    session: 'unknown' as const,
    marketSession: 'unknown' as const,
    publicationMode: 'unknown' as const,
    valueAtomic: null,
    decimals: null,
    observedAt: null,
    referenceUpdatedAt: null,
    freshness: 'unknown' as const,
    referenceSource: null,
    referenceAddress: null,
    calendar: null,
    evidence: null,
    comparable: false as const,
    reasonCode,
    reason:
      reasonCode === 'issuer_reference_not_reviewed'
        ? 'No reviewed reference source has been established for this issuer.'
        : 'No reference adapter is configured for this deployment.',
  };
}

function basisComparable(bps: string) {
  return {
    policy: 'exact_normalized_price_same_quote_window_reviewed_publication_v1' as const,
    status: 'comparable' as const,
    kind: 'current_reference' as const,
    premiumDiscountBps: bps,
    reasonCode: 'current_reference_comparable' as const,
    reason: 'The quote and the reference publication fall inside one reviewed window.',
  };
}

function basisWithheld(
  reasonCode:
    | 'reference_unknown'
    | 'expired_quote'
    | 'no_route'
    | 'unsized_sell'
    | 'zero_supply'
    | 'measurement_failed'
    | 'unreviewed_issuer_reference'
    | 'reference_timing_outside_quote_window',
  reason: string,
) {
  return {
    policy: 'exact_normalized_price_same_quote_window_reviewed_publication_v1' as const,
    status: 'withheld' as const,
    kind: 'withheld' as const,
    premiumDiscountBps: null,
    reasonCode,
    reason,
  };
}

function quotedSource(source: string, inputAtomic: string, outputAtomic: string, direction: 'buy' | 'sell') {
  return {
    source,
    status: 'quoted' as const,
    errorCode: null,
    quoteEvidence: {
      kind: 'router_quote' as const,
      source,
      direction,
      routeKey: `${source}:${USDC}:${COINBASE_NVDA}`,
      candidateHash: HASH_B,
      evidenceHash: HASH_C,
      inputAtomic,
      outputAtomic,
      observedAt: '2026-08-29T17:59:40.000Z',
      expiresAt: '2026-08-29T18:00:20.000Z',
      blockNumber: '50612000',
    },
    simulationEvidence: {
      kind: 'route_simulation' as const,
      status: 'not_simulated' as const,
      evidenceHash: null,
    },
  };
}

function plainSource(
  source: string,
  status: 'no_route' | 'unsized' | 'measurement_failed' | 'not_measured',
  errorCode: string | null,
) {
  return {
    source,
    status,
    errorCode,
    quoteEvidence: null,
    simulationEvidence: {
      kind: 'route_simulation' as const,
      status: 'not_simulated' as const,
      evidenceHash: null,
    },
  };
}

function observation(
  source: string,
  status: 'quoted' | 'no_route' | 'unsized' | 'measurement_failed',
  input: { observedAt: string; expiresAt: string; returnedCashAtomic: string | null; open: boolean; errorCode?: string },
) {
  return {
    source,
    status,
    errorCode: input.errorCode ?? null,
    observedAt: input.observedAt,
    expiresAt: input.expiresAt,
    returnedCashAtomic: input.returnedCashAtomic,
    open: input.open,
  };
}

interface RepresentationOverrides {
  [key: string]: unknown;
}

function representation(over: RepresentationOverrides = {}) {
  return {
    tokenAddress: COINBASE_NVDA,
    issuerId: 'coinbase' as const,
    issuerInstrumentKey: `coinbase:b20_address:${COINBASE_NVDA}`,
    representationKind: 'b20_asset' as const,
    supply: supply('positive_supply'),
    status: 'not_measured' as const,
    routePolicyKey: POLICY,
    exactTestedTokenAtomic: null,
    normalizedExposureAtomic: null,
    normalizedExposureDecimals: null,
    normalization: 'not_established' as const,
    returnedCashAtomic: null,
    effectivePriceAtomic: null,
    effectivePriceDecimals: null,
    premiumDiscountBps: null,
    reference: referenceUnknown('issuer_reference_not_reviewed'),
    basis: basisWithheld('reference_unknown', 'No reviewed reference is established for this representation.'),
    sources: [plainSource('kyberswap', 'not_measured', null)],
    observedAt: null,
    expiresAt: null,
    liveness: 'never_measured' as const,
    lastObservation: null,
    ...over,
  };
}

/** A fully priced representation on open evidence. */
function pricedRepresentation(over: RepresentationOverrides = {}) {
  return representation({
    supply: supply('positive_supply'),
    status: 'full',
    exactTestedTokenAtomic: '5604000000000000000',
    normalizedExposureAtomic: '5604000000000000000',
    normalizedExposureDecimals: 18,
    normalization: 'reviewed_token_already_applied',
    returnedCashAtomic: '1000000000',
    effectivePriceAtomic: '17845110',
    effectivePriceDecimals: 8,
    premiumDiscountBps: '12',
    reference: referenceEstablished(),
    basis: basisComparable('12'),
    sources: [quotedSource('kyberswap', '1000000000', '5604000000000000000', 'buy')],
    observedAt: '2026-08-29T17:59:40.000Z',
    expiresAt: '2026-08-29T18:00:20.000Z',
    liveness: 'live',
    lastObservation: observation('kyberswap', 'quoted', {
      observedAt: '2026-08-29T17:59:40.000Z',
      expiresAt: '2026-08-29T18:00:20.000Z',
      returnedCashAtomic: '1000000000',
      open: true,
    }),
    ...over,
  });
}

interface ResponseOverrides {
  [key: string]: unknown;
}

function response(over: ResponseOverrides = {}): MarketRealityResponseV2 {
  return MarketRealityResponseV2Schema.parse({
    schemaVersion: 'market-reality/v2',
    question: {
      chainId: 8453,
      underlyingKey: UNDERLYING,
      direction: 'buy',
      requestedCashAtomic: '1000000000',
      cashAsset: 'USDC',
      cashAddress: USDC,
      cashDecimals: 6,
      destination: 'USDC',
      exactSizeOnly: true,
      baseOnly: true,
    },
    universe: {
      reviewedRepresentationCount: 1,
      positiveSupplyRepresentationCount: 1,
      zeroSupplyRepresentationCount: 0,
      unresolvedSupplyRepresentationCount: 0,
    },
    marketOutcomeCoverage: {
      policy: 'same_reviewed_router_policy_exact_size_direction_and_destination',
      eligibleRepresentationCount: 1,
      establishedOutcomeCount: 1,
      status: 'complete',
      reason: null,
    },
    numericComparisonCoverage: {
      policy: 'fresh_numeric_quotes_same_exact_question_and_normalization',
      eligibleRepresentationCount: 1,
      pricedRepresentationCount: 1,
      status: 'complete',
      reason: null,
    },
    ranking: {
      status: 'withheld',
      policy: 'withheld_phase_10b8',
      orderedTokenAddresses: [],
      reason: 'Ranking is withheld while the comparison policy is under review.',
    },
    quoteEvidenceIsExecutionProof: false,
    representations: [pricedRepresentation()],
    assembledAt: NOW,
    ...over,
  });
}

export interface StocksBenchCaseV1 {
  /** The letter from the phase brief, so a result can be read against it. */
  id: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J';
  name: string;
  question: string;
  reality: MarketRealityResponseV2;
  history: MarketRealityHistoryV1 | null;
}

const INCOMPLETE_COVERAGE = {
  marketOutcomeCoverage: {
    policy: 'same_reviewed_router_policy_exact_size_direction_and_destination',
    eligibleRepresentationCount: 1,
    establishedOutcomeCount: 0,
    status: 'incomplete',
    reason: 'No representation produced an established market outcome for this exact question.',
  },
  numericComparisonCoverage: {
    policy: 'fresh_numeric_quotes_same_exact_question_and_normalization',
    eligibleRepresentationCount: 1,
    pricedRepresentationCount: 0,
    status: 'incomplete',
    reason: 'No representation carries a fresh numeric quote for this exact question.',
  },
};

const SELL_QUESTION = {
  chainId: 8453,
  underlyingKey: UNDERLYING,
  direction: 'sell',
  requestedCashAtomic: '1000000000',
  cashAsset: 'USDC',
  cashAddress: USDC,
  cashDecimals: 6,
  destination: 'USDC',
  exactSizeOnly: true,
  baseOnly: true,
};

export const STOCKS_BENCH_CORPUS_V1: readonly StocksBenchCaseV1[] = [
  {
    id: 'A',
    name: 'Coinbase priced on fresh evidence',
    question: 'What does it cost to put 1,000 USDC into the Coinbase representation of NVDA on Base?',
    reality: response(),
    history: null,
  },
  {
    id: 'B',
    name: 'Coinbase quote expired',
    question: 'What does the Coinbase representation of NVDA cost right now?',
    reality: response({
      ...INCOMPLETE_COVERAGE,
      representations: [
        representation({
          status: 'unavailable',
          liveness: 'history_only',
          basis: basisWithheld(
            'expired_quote',
            'The newest quote for this representation is outside its own validity window.',
          ),
          lastObservation: observation('kyberswap', 'quoted', {
            observedAt: '2026-08-29T17:12:00.000Z',
            expiresAt: '2026-08-29T17:12:20.000Z',
            returnedCashAtomic: '1000000000',
            open: false,
          }),
          reference: referenceEstablished(),
          sources: [plainSource('kyberswap', 'not_measured', null)],
        }),
      ],
    }),
    history: null,
  },
  {
    id: 'C',
    name: 'Backed has supply and no reviewed route',
    question: 'Can I exit the Backed representation of NVDA for 1,000 USDC?',
    reality: response({
      ...INCOMPLETE_COVERAGE,
      question: SELL_QUESTION,
      representations: [
        representation({
          tokenAddress: BACKED_NVDA,
          issuerId: 'backed',
          issuerInstrumentKey: 'backed:instrument:bNVDA',
          representationKind: 'rebasing_erc20',
          status: 'unavailable',
          liveness: 'live',
          reference: referenceUnknown('issuer_reference_not_reviewed'),
          basis: basisWithheld('no_route', 'No reviewed router returned a route at this exact size.'),
          sources: [plainSource('kyberswap', 'no_route', 'no_route_at_exact_size')],
          observedAt: '2026-08-29T17:59:40.000Z',
          expiresAt: '2026-08-29T18:00:20.000Z',
          lastObservation: observation('kyberswap', 'no_route', {
            observedAt: '2026-08-29T17:59:40.000Z',
            expiresAt: '2026-08-29T18:00:20.000Z',
            returnedCashAtomic: null,
            open: true,
            errorCode: 'no_route_at_exact_size',
          }),
        }),
      ],
    }),
    history: null,
  },
  {
    id: 'D',
    name: 'SELL unsized because the BUY anchor failed',
    question: 'How much of the Coinbase NVDA token equals 1,000 USDC on the way out?',
    reality: response({
      ...INCOMPLETE_COVERAGE,
      question: SELL_QUESTION,
      representations: [
        representation({
          status: 'unavailable',
          liveness: 'live',
          basis: basisWithheld(
            'unsized_sell',
            'The BUY anchor that converts a cash size into a token amount found no route, so the SELL has no exact size.',
          ),
          sources: [plainSource('kyberswap', 'unsized', 'cash_size_anchor_no_route')],
          observedAt: '2026-08-29T17:59:40.000Z',
          expiresAt: '2026-08-29T18:00:20.000Z',
          lastObservation: observation('kyberswap', 'unsized', {
            observedAt: '2026-08-29T17:59:40.000Z',
            expiresAt: '2026-08-29T18:00:20.000Z',
            returnedCashAtomic: null,
            open: true,
            errorCode: 'cash_size_anchor_no_route',
          }),
        }),
      ],
    }),
    history: null,
  },
  {
    id: 'E',
    name: 'Zero-supply wrapper',
    question: 'What about the wrapped Backed NVDA token?',
    reality: response({
      ...INCOMPLETE_COVERAGE,
      universe: {
        reviewedRepresentationCount: 1,
        positiveSupplyRepresentationCount: 0,
        zeroSupplyRepresentationCount: 1,
        unresolvedSupplyRepresentationCount: 0,
      },
      representations: [
        representation({
          tokenAddress: BACKED_WRAPPER,
          issuerId: 'backed',
          issuerInstrumentKey: 'backed:instrument:wbNVDA',
          representationKind: 'non_rebasing_erc4626_wrapper',
          supply: supply('zero_supply'),
          basis: basisWithheld(
            'zero_supply',
            'No outstanding supply exists at the latest fresh read, so there is no position to size.',
          ),
        }),
      ],
    }),
    history: null,
  },
  {
    id: 'F',
    name: 'Backed priced, reference unknown',
    question: 'Is the Backed representation of NVDA trading above or below its reference?',
    reality: response({
      numericComparisonCoverage: {
        policy: 'fresh_numeric_quotes_same_exact_question_and_normalization',
        eligibleRepresentationCount: 1,
        pricedRepresentationCount: 1,
        status: 'incomplete',
        reason: 'No reviewed reference is established for the Backed issuer, so no basis can be published.',
      },
      representations: [
        pricedRepresentation({
          tokenAddress: BACKED_NVDA,
          issuerId: 'backed',
          issuerInstrumentKey: 'backed:instrument:bNVDA',
          representationKind: 'rebasing_erc20',
          premiumDiscountBps: null,
          reference: referenceUnknown('issuer_reference_not_reviewed'),
          basis: basisWithheld(
            'unreviewed_issuer_reference',
            'No reviewed reference source is established for this issuer.',
          ),
        }),
      ],
    }),
    history: null,
  },
  {
    id: 'G',
    name: 'Reference established, basis still withheld',
    question: 'What is the premium on the Coinbase representation of NVDA?',
    reality: response({
      numericComparisonCoverage: {
        policy: 'fresh_numeric_quotes_same_exact_question_and_normalization',
        eligibleRepresentationCount: 1,
        pricedRepresentationCount: 1,
        status: 'incomplete',
        reason: 'The reference publication falls outside the reviewed window of the quote.',
      },
      representations: [
        pricedRepresentation({
          premiumDiscountBps: null,
          basis: basisWithheld(
            'reference_timing_outside_quote_window',
            'The reference was published outside the reviewed window that contains this quote, so the two are not comparable.',
          ),
        }),
      ],
    }),
    history: null,
  },
  {
    id: 'H',
    name: 'Comparable historical change',
    question: 'Has the cost of putting 1,000 USDC into Coinbase NVDA changed today?',
    reality: response(),
    history: MarketRealityHistoryV1Schema.parse({
      schemaVersion: 'market-reality-history/v1',
      chainId: 8453,
      underlyingKey: UNDERLYING,
      direction: 'buy',
      requestedCashAtomic: '1000000000',
      destination: 'USDC',
      window: '24h',
      since: '2026-08-28T18:00:00.000Z',
      interpolated: false,
      representations: [
        {
          tokenAddress: COINBASE_NVDA,
          issuerId: 'coinbase',
          representationKind: 'b20_asset',
          points: [
            {
              observedAt: '2026-08-29T06:00:00.000Z',
              status: 'quoted',
              source: 'kyberswap',
              returnedCashAtomic: '1000000000',
              testedTokenAtomic: '5588000000000000000',
              errorCode: null,
              approvedSources: ['kyberswap'],
              marketReality: null,
            },
            {
              observedAt: '2026-08-29T17:59:40.000Z',
              status: 'quoted',
              source: 'kyberswap',
              returnedCashAtomic: '1000000000',
              testedTokenAtomic: '5604000000000000000',
              errorCode: null,
              approvedSources: ['kyberswap'],
              marketReality: null,
            },
          ],
          pointCount: 2,
          quotedCount: 2,
          firstObservedAt: '2026-08-29T06:00:00.000Z',
          lastObservedAt: '2026-08-29T17:59:40.000Z',
        },
      ],
      assembledAt: NOW,
    }),
  },
  {
    id: 'I',
    name: 'Miorail could not complete the read',
    question: 'What does the Coinbase representation of NVDA cost?',
    reality: response({
      ...INCOMPLETE_COVERAGE,
      universe: {
        reviewedRepresentationCount: 1,
        positiveSupplyRepresentationCount: 0,
        zeroSupplyRepresentationCount: 0,
        unresolvedSupplyRepresentationCount: 1,
      },
      representations: [
        representation({
          supply: supply('supply_unknown', 'rpc_failure'),
          status: 'measurement_failed',
          basis: basisWithheld('measurement_failed', 'The measurement did not complete for this representation.'),
          sources: [plainSource('kyberswap', 'measurement_failed', 'router_request_failed')],
        }),
      ],
    }),
    history: null,
  },
  {
    id: 'J',
    name: 'One security, three representations, mixed states',
    question: 'Сравни все представления NVDA на Base для выхода на 1 000 USDC.',
    reality: response({
      question: SELL_QUESTION,
      universe: {
        reviewedRepresentationCount: 3,
        positiveSupplyRepresentationCount: 2,
        zeroSupplyRepresentationCount: 1,
        unresolvedSupplyRepresentationCount: 0,
      },
      marketOutcomeCoverage: {
        policy: 'same_reviewed_router_policy_exact_size_direction_and_destination',
        eligibleRepresentationCount: 2,
        establishedOutcomeCount: 2,
        status: 'complete',
        reason: null,
      },
      numericComparisonCoverage: {
        policy: 'fresh_numeric_quotes_same_exact_question_and_normalization',
        eligibleRepresentationCount: 2,
        pricedRepresentationCount: 1,
        status: 'incomplete',
        reason: 'One eligible representation returned no route at this exact size.',
      },
      representations: [
        pricedRepresentation({
          sources: [quotedSource('kyberswap', '5604000000000000000', '1000000000', 'sell')],
        }),
        representation({
          tokenAddress: BACKED_NVDA,
          issuerId: 'backed',
          issuerInstrumentKey: 'backed:instrument:bNVDA',
          representationKind: 'rebasing_erc20',
          status: 'unavailable',
          liveness: 'live',
          basis: basisWithheld('no_route', 'No reviewed router returned a route at this exact size.'),
          sources: [plainSource('kyberswap', 'no_route', 'no_route_at_exact_size')],
          observedAt: '2026-08-29T17:59:40.000Z',
          expiresAt: '2026-08-29T18:00:20.000Z',
          lastObservation: observation('kyberswap', 'no_route', {
            observedAt: '2026-08-29T17:59:40.000Z',
            expiresAt: '2026-08-29T18:00:20.000Z',
            returnedCashAtomic: null,
            open: true,
            errorCode: 'no_route_at_exact_size',
          }),
        }),
        representation({
          tokenAddress: BACKED_WRAPPER,
          issuerId: 'backed',
          issuerInstrumentKey: 'backed:instrument:wbNVDA',
          representationKind: 'non_rebasing_erc4626_wrapper',
          supply: supply('zero_supply'),
          basis: basisWithheld(
            'zero_supply',
            'No outstanding supply exists at the latest fresh read, so there is no position to size.',
          ),
        }),
      ],
    }),
    history: null,
  },
];

export const STOCKS_BENCH_ADDRESSES_V1 = {
  COINBASE_NVDA,
  BACKED_NVDA,
  BACKED_WRAPPER,
  USDC,
  UNDERLYING,
} as const;
