import { stableHashV1 } from '@mioagent/route-domain';
import {
  type OfficialCashExitRepositoryV1,
  type RepresentationRatioRepositoryV1,
  type RepresentationSupplyRepositoryV1,
  type UnderlyingAssetRepositoryV1,
} from '@mioagent/route-storage';
import { z } from 'zod';

import { MarketRealityResponseV2Schema, type MarketRealityResponseV2 } from './contracts.js';
import { marketRealityAgentSummaryV1 } from './agentSummary.js';
import {
  ISSUER_BY_REVIEWED_SOURCE_KIND_V1,
  canonicalReviewedBindingV1,
} from './canonicalBinding.js';
import {
  deriveMarketRealityRadarEventsV1,
  marketRealityRadarPointFromRunV1,
  MarketRealityRadarEventV1Schema,
  MarketRealityRadarPointV1Schema,
  type MarketRealityComparabilityKeyV1,
  type MarketRealityRadarPointV1,
} from './radar.js';
import { assembleMarketRealityV2, supplyEvidenceV1, type MarketRealityDepsV1 } from './engine.js';
import { MARKET_REALITY_WINDOWS_V1, type MarketRealityWindowV1 } from './history.js';

const AddressV1 = z.string().regex(/^0x[0-9a-f]{40}$/);
const HashV1 = z.string().regex(/^0x[0-9a-f]{64}$/);
const TimestampV1 = z.string().datetime();
const UnderlyingKeyV1 = z
  .string()
  .regex(/^[a-z0-9_]+:[a-z0-9_]+:.+$/)
  .max(200);
const PositiveUsdV1 = z
  .number()
  .positive()
  .max(1_000_000_000)
  // Six decimal places, tested against the rounding this module actually
  // applies. `100.1 * 1_000_000` is 100100000.00000001 in IEEE-754, so a bare
  // integer test rejects sizes the converter handles exactly.
  .refine(
    (value) => {
      const micros = value * 1_000_000;
      const rounded = Math.round(micros);
      return Number.isSafeInteger(rounded) && Math.abs(micros - rounded) < 1e-3;
    },
    { message: 'sizeUsd must be exact to at most six decimal places' },
  );

export const MarketRealityAgentRepresentationsInputV1Schema = z
  .object({
    underlyingKey: UnderlyingKeyV1,
    chain: z.literal('base'),
  })
  .strict();

export const MarketRealityAgentComparisonInputV1Schema = z
  .object({
    underlyingKey: UnderlyingKeyV1,
    sizeUsd: PositiveUsdV1,
    direction: z.enum(['buy', 'sell']),
    destination: z.enum(['USDC', 'ETH']),
    chain: z.literal('base'),
  })
  .strict();

/** `address` accepts an exact Base address or its exact CAIP-10 spelling. A
 * ticker is intentionally not part of the schema. */
export const MarketRealityAgentChangesInputV1Schema = z
  .object({
    address: z
      .string()
      .refine(
        (value) =>
          /^0x[0-9a-fA-F]{40}$/.test(value) || /^eip155:8453:0x[0-9a-fA-F]{40}$/.test(value),
        { message: 'an exact Base address or CAIP-10 is required' },
      ),
    sizeUsd: PositiveUsdV1,
    direction: z.enum(['buy', 'sell']),
    destination: z.enum(['USDC', 'ETH']),
    window: z.enum(['1h', '6h', '24h', '7d']),
    chain: z.literal('base'),
  })
  .strict();

const ReviewedIdentityEvidenceV1Schema = z
  .object({
    sourceKind: z.enum(['dinari_stock_api', 'backed_assets_api', 'coinbase_b20_metadata']),
    sourceRef: z.string().min(1).max(300),
    sourceHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    evidenceStrength: z
      .enum([
        'reviewed_issuer_identifier',
        'reviewed_machine_address_mapping',
        'reviewed_machine_mapping_with_onchain_cross_check',
      ])
      .nullable(),
    reviewedCaip10: z
      .string()
      .regex(/^eip155:8453:0x[0-9a-f]{40}$/)
      .nullable(),
    observedBlockNumber: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .nullable(),
    observedBlockHash: z
      .string()
      .regex(/^0x[0-9a-f]{64}$/)
      .nullable(),
    observedAt: TimestampV1,
  })
  .strict();

const AgentSupplyV1Schema = z
  .object({
    state: z.enum(['positive_supply', 'zero_supply', 'supply_unknown']),
    totalSupplyAtomic: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .nullable(),
    decimals: z.number().int().min(0).max(36).nullable(),
    readOutcome: z.enum(['success', 'rpc_failure', 'decode_failure', 'not_observed']),
    fresh: z.boolean(),
    evidenceHash: HashV1.nullable(),
    observedAt: TimestampV1.nullable(),
    reason: z.string().min(1).max(240).nullable(),
  })
  .strict();

export const MarketRealityAgentRepresentationsOutputV1Schema = z
  .object({
    schemaVersion: z.literal('miorail-agent-representations/v1'),
    chain: z.literal('base'),
    chainId: z.literal(8453),
    underlying: z
      .object({
        underlyingKey: UnderlyingKeyV1,
        canonicalName: z.string().min(1).max(200),
        displaySymbol: z.string().min(1).max(40).nullable(),
        assetClass: z.enum(['equity', 'fund_share', 'other', 'unknown']),
        identifierScheme: z.enum(['isin', 'dinari_stock_id', 'composite_figi']).nullable(),
        identifierValue: z.string().min(1).max(120).nullable(),
        sourceKind: z.enum(['dinari_stock_api', 'backed_assets_api', 'coinbase_b20_metadata']),
        sourceRef: z.string().min(1).max(300),
        sourceHash: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .nullable(),
        observedAt: TimestampV1,
      })
      .strict()
      .nullable(),
    representationCount: z.number().int().min(0),
    selection: z
      .object({
        status: z.literal('not_selected'),
        reason: z.literal('Every reviewed representation is returned separately by exact address.'),
      })
      .strict(),
    representations: z.array(
      z
        .object({
          tokenAddress: AddressV1,
          caip10: z.string().regex(/^eip155:8453:0x[0-9a-f]{40}$/),
          // Recovered from the exact address when the stored row predates
          // migration 0059, so this is never `null` and never "unknown".
          issuerId: z.enum(['coinbase', 'dinari', 'backed']),
          issuerInstrumentKey: z.string().min(1).max(200),
          /** True when the issuer typing was completed from the exact address
           * rather than read from the stored binding. */
          issuerTypingRecovered: z.boolean(),
          representationKind: z
            .enum(['b20_asset', 'rebasing_erc20', 'non_rebasing_erc4626_wrapper'])
            .nullable(),
          supply: AgentSupplyV1Schema,
          identityEvidence: ReviewedIdentityEvidenceV1Schema,
        })
        .strict(),
    ),
    assembledAt: TimestampV1,
  })
  .strict();

/**
 * Miorail's own reading of the comparison, beside the comparison.
 *
 * Deterministic and derived: every sentence is a rearrangement of counts the
 * payload already carries. It exists because `establishedOutcomeCount: 0` is a
 * fact about OUR coverage that an external model, asked for English, turns into
 * a claim about the market.
 */
export const MarketRealityAgentSummaryV1Schema = z
  .object({
    summary: z.string().min(1).max(1000),
    currentComparisonAvailable: z.boolean(),
    nextSafeStep: z.string().min(1).max(500),
    notEstablished: z.string().min(1).max(500),
    representations: z
      .array(
        z
          .object({
            tokenAddress: z.string(),
            issuerId: z.string(),
            line: z.string().min(1).max(300),
            inCurrentComparison: z.boolean(),
          })
          .strict(),
      )
      .max(16),
  })
  .strict();

export const MarketRealityAgentComparisonOutputV1Schema = z
  .object({
    schemaVersion: z.literal('miorail-agent-market-reality/v1'),
    chain: z.literal('base'),
    quoteOnly: z.literal(true),
    executionEvidenceIncluded: z.literal(false),
    /** Read this first, and prefer it to improvising from the counts below. */
    miorailSummary: MarketRealityAgentSummaryV1Schema,
    comparison: MarketRealityResponseV2Schema,
  })
  .strict();

/**
 * The public shape of a change, defined ONCE and used twice.
 *
 * The transform below is the door an event comes through; this is what is on
 * the other side of it. The output schema must reference THIS, never the
 * transform: `MarketRealityAgentChangesOutputV1Schema` re-parses the assembled
 * response, and a transform re-run over its own output demands the input shape
 * back -- so every already-stripped change failed on the `eventId` and
 * `watchId` that stripping them had just removed. The tool answered only while
 * `changes` was empty, which is exactly the case a fixture asserting `[]`
 * cannot catch.
 */
const PublicRadarChangeShapeV1Schema = z
  .object({
    chainId: z.literal(8453),
    tokenAddress: AddressV1,
    previousSnapshotHash: HashV1,
    snapshotHash: HashV1,
    previousObservedAt: TimestampV1,
    occurredAt: TimestampV1,
    approvedSources: z.array(z.string().min(1).max(100)).min(1).max(16),
    kind: z.enum([
      'sell_exit_cost_changed',
      'buy_effective_price_changed',
      'route_became_unavailable',
      'route_became_available',
      'market_session_changed',
      'reference_became_stale',
      'representation_ratio_changed',
    ]),
    facts: z.record(z.unknown()),
  })
  .strict();

const PublicRadarChangeV1Schema = MarketRealityRadarEventV1Schema.transform(
  ({ eventId: _eventId, watchId: _watchId, ...event }) => event,
).pipe(PublicRadarChangeShapeV1Schema);

const AgentHistoryEntryV1Schema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('comparable_observation'),
      runId: HashV1,
      completedAt: TimestampV1,
      evidenceClass: z.literal('router_quote'),
      point: MarketRealityRadarPointV1Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('gap'),
      runId: HashV1,
      completedAt: TimestampV1,
      evidenceClass: z.literal('router_quote'),
      outcome: z.enum(['measurement_failed', 'unsized', 'policy_changed']),
      assetEvent: z.literal(false),
    })
    .strict(),
]);

export const MarketRealityAgentChangesOutputV1Schema = z
  .object({
    schemaVersion: z.literal('miorail-agent-market-changes/v1'),
    chain: z.literal('base'),
    chainId: z.literal(8453),
    tokenAddress: AddressV1,
    caip10: z.string().regex(/^eip155:8453:0x[0-9a-f]{40}$/),
    underlyingKey: UnderlyingKeyV1,
    question: z
      .object({
        requestedCashAtomic: z.string().regex(/^[1-9][0-9]*$/),
        sizeUsd: PositiveUsdV1,
        direction: z.enum(['buy', 'sell']),
        destination: z.enum(['USDC', 'ETH']),
        exactSizeOnly: z.literal(true),
      })
      .strict(),
    window: z.enum(['1h', '6h', '24h', '7d']),
    since: TimestampV1,
    interpolated: z.literal(false),
    routePolicy: z
      .object({
        routePolicyKey: HashV1,
        approvedSources: z.array(z.string().min(1).max(100)).min(1).max(16),
      })
      .strict()
      .nullable(),
    observations: z.array(AgentHistoryEntryV1Schema).max(500),
    changes: z.array(PublicRadarChangeShapeV1Schema).max(500),
    privateRadarMetadataIncluded: z.literal(false),
    assembledAt: TimestampV1,
  })
  .strict();

export type MarketRealityAgentRepresentationsInputV1 = z.infer<
  typeof MarketRealityAgentRepresentationsInputV1Schema
>;
export type MarketRealityAgentComparisonInputV1 = z.infer<
  typeof MarketRealityAgentComparisonInputV1Schema
>;
export type MarketRealityAgentChangesInputV1 = z.infer<
  typeof MarketRealityAgentChangesInputV1Schema
>;

export interface MarketRealityAgentDepsV1 extends MarketRealityDepsV1 {
  underlyings: UnderlyingAssetRepositoryV1;
  cashExit: OfficialCashExitRepositoryV1;
  ratios: RepresentationRatioRepositoryV1;
  supplies: RepresentationSupplyRepositoryV1;
}

export function marketRealityUsdToAtomicV1(sizeUsd: number): string {
  return BigInt(Math.round(PositiveUsdV1.parse(sizeUsd) * 1_000_000)).toString();
}

function exactAddressV1(value: string): string {
  return (
    value.toLowerCase().startsWith('eip155:8453:') ? value.slice('eip155:8453:'.length) : value
  ).toLowerCase();
}

export async function getMarketRealityRepresentationsForAgentV1(
  deps: Pick<MarketRealityAgentDepsV1, 'underlyings' | 'supplies' | 'ratios' | 'now'>,
  rawInput: MarketRealityAgentRepresentationsInputV1,
) {
  const input = MarketRealityAgentRepresentationsInputV1Schema.parse(rawInput);
  const now = deps.now();
  const bindings = await deps.underlyings.representationsOf({
    chainId: 8453,
    underlyingKey: input.underlyingKey,
  });
  const supplies = await deps.supplies.readSupplies({
    chainId: 8453,
    tokenAddresses: bindings.map((row) => row.tokenAddress),
  });
  const supplyByAddress = new Map(supplies.map((row) => [row.tokenAddress, row]));
  // This surface lists every reviewed row, so a structure that cannot be
  // established stays `null` here rather than removing the address. The issuer
  // is recovered either way, so no row is listed without one.
  const ratios = await deps.ratios.readRatios({
    chainId: 8453,
    tokenAddresses: bindings.map((row) => row.tokenAddress),
  });
  const ratioByAddress = new Map(ratios.map((row) => [row.tokenAddress, row]));
  const identity = bindings[0]
    ? await deps.underlyings.underlyingOf({
        chainId: 8453,
        tokenAddress: bindings[0].tokenAddress,
      })
    : null;

  return MarketRealityAgentRepresentationsOutputV1Schema.parse({
    schemaVersion: 'miorail-agent-representations/v1',
    chain: 'base',
    chainId: 8453,
    underlying: identity
      ? {
          underlyingKey: identity.underlying.underlyingKey,
          canonicalName: identity.underlying.canonicalName,
          displaySymbol: identity.underlying.displaySymbol ?? null,
          assetClass: identity.underlying.assetClass,
          identifierScheme: identity.underlying.identifierScheme ?? null,
          identifierValue: identity.underlying.identifierValue ?? null,
          sourceKind: identity.underlying.sourceKind,
          sourceRef: identity.underlying.sourceRef,
          sourceHash: identity.underlying.sourceHash ?? null,
          observedAt: identity.underlying.observedAt,
        }
      : null,
    representationCount: bindings.length,
    selection: {
      status: 'not_selected',
      reason: 'Every reviewed representation is returned separately by exact address.',
    },
    representations: bindings.map((row) => {
      const canonical = canonicalReviewedBindingV1(
        row,
        ratioByAddress.get(row.tokenAddress) ?? null,
      );
      const binding = canonical.status === 'canonical' ? canonical.binding : row;
      const issuerId = binding.issuerId ?? ISSUER_BY_REVIEWED_SOURCE_KIND_V1[binding.sourceKind];
      const supply = supplyEvidenceV1(
        supplyByAddress.get(binding.tokenAddress) ?? null,
        now.getTime(),
      );
      return {
        tokenAddress: binding.tokenAddress,
        caip10: `eip155:8453:${binding.tokenAddress}`,
        issuerId,
        issuerInstrumentKey:
          binding.issuerInstrumentKey ?? `${issuerId}:base_address:${binding.tokenAddress}`,
        issuerTypingRecovered:
          row.issuerId == null || row.issuerInstrumentKey == null || row.representationKind == null,
        representationKind: binding.representationKind ?? null,
        supply: {
          state: supply.state,
          totalSupplyAtomic: supply.totalSupplyAtomic,
          decimals: supply.decimals,
          readOutcome: supply.readOutcome,
          fresh: supply.fresh,
          evidenceHash: supply.evidenceHash,
          observedAt: supply.observedAt,
          reason: supply.reason,
        },
        identityEvidence: {
          sourceKind: binding.sourceKind,
          sourceRef: binding.sourceRef,
          sourceHash: binding.sourceHash ?? null,
          evidenceStrength: binding.evidenceStrength ?? null,
          reviewedCaip10: binding.caip10 ?? null,
          observedBlockNumber: binding.observedBlockNumber ?? null,
          observedBlockHash: binding.observedBlockHash ?? null,
          observedAt: binding.observedAt,
        },
      };
    }),
    assembledAt: now.toISOString(),
  });
}

export async function compareMarketRealityForAgentV1(
  deps: MarketRealityAgentDepsV1,
  rawInput: MarketRealityAgentComparisonInputV1,
) {
  const input = MarketRealityAgentComparisonInputV1Schema.parse(rawInput);
  const comparison = await assembleMarketRealityV2(deps, {
    underlyingKey: input.underlyingKey,
    direction: input.direction,
    requestedCashAtomic: marketRealityUsdToAtomicV1(input.sizeUsd),
    destination: input.destination,
  });
  const parsed = MarketRealityResponseV2Schema.parse(comparison);
  return MarketRealityAgentComparisonOutputV1Schema.parse({
    schemaVersion: 'miorail-agent-market-reality/v1',
    chain: 'base',
    quoteOnly: true,
    executionEvidenceIncluded: false,
    miorailSummary: marketRealityAgentSummaryV1(parsed),
    comparison: parsed,
  });
}

export async function getMarketRealityChangesForAgentV1(
  deps: MarketRealityAgentDepsV1,
  rawInput: MarketRealityAgentChangesInputV1,
) {
  const input = MarketRealityAgentChangesInputV1Schema.parse(rawInput);
  const tokenAddress = exactAddressV1(input.address);
  const identity = await deps.underlyings.underlyingOf({ chainId: 8453, tokenAddress });
  if (!identity) throw new Error('representation_not_reviewed');
  const requestedCashAtomic = marketRealityUsdToAtomicV1(input.sizeUsd);
  const now = deps.now();
  const since = new Date(
    now.getTime() - MARKET_REALITY_WINDOWS_V1[input.window as MarketRealityWindowV1],
  ).toISOString();
  const current: MarketRealityResponseV2 = await assembleMarketRealityV2(deps, {
    underlyingKey: identity.binding.underlyingKey,
    direction: input.direction,
    requestedCashAtomic,
    destination: input.destination,
  });
  const currentRepresentation = current.representations.find(
    (row) => row.tokenAddress === tokenAddress,
  );
  const latestRun = await deps.cashExit.latestCompletedRun({
    chainId: 8453,
    tokenAddress,
    scope: 'public_ladder',
  });
  const routePolicy =
    currentRepresentation?.routePolicyKey && latestRun?.approvedSources.length
      ? {
          routePolicyKey: currentRepresentation.routePolicyKey,
          approvedSources: [...latestRun.approvedSources].sort(),
        }
      : null;
  const runs = await deps.cashExit.completedRunsSince({
    chainId: 8453,
    tokenAddress,
    scope: 'public_ladder',
    since,
    limit: 500,
  });

  const observations: z.infer<typeof AgentHistoryEntryV1Schema>[] = [];
  const changes: Array<z.output<typeof PublicRadarChangeV1Schema>> = [];
  let previous: MarketRealityRadarPointV1 | null = null;

  if (routePolicy) {
    const syntheticWatch = {
      watchId: stableHashV1('public-market-changes/v1', {
        tokenAddress,
        requestedCashAtomic,
        direction: input.direction,
        destination: input.destination,
        routePolicyKey: routePolicy.routePolicyKey,
      }),
      userId: 'public-market-changes',
      chainId: 8453,
      underlyingKey: identity.binding.underlyingKey,
      tokenAddress,
      direction: input.direction,
      requestedCashAtomic,
      destination: input.destination,
      routePolicyKey: routePolicy.routePolicyKey,
      approvedSources: routePolicy.approvedSources,
      createdAt: since,
      lastEvaluatedAt: null,
      lastComparableAt: null,
      lastEvaluationOutcome: null,
      // No issuer and no representation kind. This is a comparability key, not
      // a tenant watch, and a reviewed binding whose issuer typing is still
      // incomplete must not have one asserted on its behalf here.
    } satisfies MarketRealityComparabilityKeyV1;

    for (const run of [...runs].reverse()) {
      const askedExactQuestion = run.observations.some(
        (row) =>
          row.requestedCashAtomic === requestedCashAtomic && row.destination === input.destination,
      );
      if (!askedExactQuestion) continue;
      const selected = marketRealityRadarPointFromRunV1(run, syntheticWatch);
      if (selected.point === null) {
        observations.push({
          kind: 'gap',
          runId: run.runId,
          completedAt: run.completedAt,
          evidenceClass: 'router_quote',
          outcome: selected.outcome,
          assetEvent: false,
        });
        continue;
      }
      observations.push({
        kind: 'comparable_observation',
        runId: run.runId,
        completedAt: run.completedAt,
        evidenceClass: 'router_quote',
        point: selected.point,
      });
      if (previous) {
        for (const event of deriveMarketRealityRadarEventsV1({
          watch: syntheticWatch,
          previous,
          next: selected.point,
        })) {
          changes.push(PublicRadarChangeV1Schema.parse(event));
        }
      }
      previous = selected.point;
    }
  }

  return MarketRealityAgentChangesOutputV1Schema.parse({
    schemaVersion: 'miorail-agent-market-changes/v1',
    chain: 'base',
    chainId: 8453,
    tokenAddress,
    caip10: `eip155:8453:${tokenAddress}`,
    underlyingKey: identity.binding.underlyingKey,
    question: {
      requestedCashAtomic,
      sizeUsd: input.sizeUsd,
      direction: input.direction,
      destination: input.destination,
      exactSizeOnly: true,
    },
    window: input.window,
    since,
    interpolated: false,
    routePolicy,
    observations,
    changes,
    privateRadarMetadataIncluded: false,
    assembledAt: now.toISOString(),
  });
}
