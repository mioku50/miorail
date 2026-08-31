import { stableHashV1, type HashV1 } from '@mioagent/route-domain';
import { CashExitLadderV1Schema } from '@mioagent/rwa-cash-exit/contracts';
import { z } from 'zod';

const Address = z.string().regex(/^0x[0-9a-f]{40}$/);
const Hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const Timestamp = z.string().datetime();
const Digits = z.string().regex(/^(0|[1-9][0-9]*)$/);

export const DossierEvidenceRefV1Schema = z
  .object({
    kind: z.enum([
      'reviewed_source_snapshot',
      'reviewed_identity_mapping',
      'base_chain_call',
      'chainlink_feed',
      'stored_market_tail',
      'router_quote',
    ]),
    /**
     * Where the evidence came from — usually a URL, and the bound has to fit a
     * real one.
     *
     * It was 160, which silently made four of the five live Coinbase dossiers
     * un-servable: the reviewed identity binding joins BOTH of its sources into
     * one reference (`<prospectus URL>#page=67#extraMetadata(isin)`), which runs
     * to 189-190 characters. The parse threw, the route's catch turned it into a
     * bare 500, and nothing was logged. The rule that makes the binding
     * trustworthy is exactly what made the reference long.
     *
     * Truncating instead would be worse than a wide bound: a citation a reader
     * cannot follow is decoration, not provenance.
     */
    source: z.string().min(1).max(512),
    observedAt: Timestamp,
    blockNumber: Digits.nullable(),
    blockHash: Hash.nullable(),
    targetAddress: Address.nullable(),
    method: z.string().min(1).max(120).nullable(),
    evidenceHash: Hash.nullable(),
  })
  .strict();
export type DossierEvidenceRefV1 = z.infer<typeof DossierEvidenceRefV1Schema>;

export const OfficialDossierListingV1Schema = z
  .object({
    sourceKind: z.enum(['base_docs_technical', 'base_product_list', 'backed_assets_api']),
    sourceUrl: z.string().url().startsWith('https://'),
    ticker: z.string().min(1).max(16),
    displayName: z.string().min(1).max(120).nullable(),
    referenceFeedAddress: Address.nullable(),
    firstSeenAt: Timestamp,
    lastSeenAt: Timestamp,
    currentlyListed: z.boolean(),
    sourceCheckedAt: Timestamp.nullable(),
    sourceStatus: z.enum(['ok', 'unreachable', 'unparsable']).nullable(),
    evidence: DossierEvidenceRefV1Schema,
  })
  .strict();

export const OfficialDossierIdentityV1Schema = z
  .object({
    status: z.literal('official_exact_address_match'),
    chainId: z.literal(8453),
    tokenAddress: Address,
    issuer: z.string().min(1).max(80),
    ticker: z.string().min(1).max(16),
    displayName: z.string().min(1).max(120).nullable(),
    underlying: z
      .object({
        status: z.enum(['supported_by_reviewed_source', 'not_established']),
        underlyingKey: z.string().min(1).max(200).nullable(),
        identifierScheme: z.enum(['isin', 'dinari_stock_id', 'composite_figi']).nullable(),
        identifierValue: z.string().min(1).max(120).nullable(),
        symbol: z.string().min(1).max(24).nullable(),
        name: z.string().min(1).max(120).nullable(),
        reason: z.string().min(1).max(240).nullable(),
        evidence: DossierEvidenceRefV1Schema.nullable(),
      })
      .strict(),
    listings: z.array(OfficialDossierListingV1Schema).min(1).max(8),
    sourceDiscrepancy: z.boolean(),
  })
  .strict();

export const DossierControlFieldV1Schema = z
  .object({
    key: z.enum([
      'token_name',
      'token_symbol',
      'token_decimals',
      'supply_cap',
      'paused_features',
      'transfer_sender_policy',
      'transfer_receiver_policy',
      'transfer_executor_policy',
      'rebase_multiplier',
    ]),
    status: z.enum(['exact_chain_read', 'unavailable', 'unsupported_by_variant']),
    value: z.string().max(300).nullable(),
    reason: z.string().min(1).max(400).nullable(),
    evidence: DossierEvidenceRefV1Schema.nullable(),
  })
  .strict();

export const DossierControlsV1Schema = z
  .object({
    status: z.enum(['complete', 'partial', 'unavailable']),
    blockNumber: Digits.nullable(),
    blockHash: Hash.nullable(),
    observedAt: Timestamp,
    multiplier: z
      .object({
        status: z.enum(['exact_chain_read', 'unavailable']),
        atomic: Digits.nullable(),
        decimals: z.literal(18),
        evidence: DossierEvidenceRefV1Schema.nullable(),
      })
      .strict(),
    fields: z.array(DossierControlFieldV1Schema).max(16),
  })
  .strict();

/**
 * The current multiplier for one representation.
 *
 * `appliedToReference` is a literal `false` and must stay one. For Coinbase
 * B20, the Chainlink total-return feed has already applied the multiplier,
 * which is what `ReferenceValueV1.multiplierAppliedByFeed: true` asserts; a
 * second application here would double-count every corporate action. Another
 * issuer with no reviewed reference adapter carries null reference semantics.
 *
 * `oneToOne` is the sentence a reader needs — "one token is one share" — and
 * it is `null`, never `true`, when the value could not be read.
 */
export const RepresentationMultiplierV1Schema = z
  .object({
    status: z.enum(['read', 'absent', 'unavailable', 'invalid']),
    tokenAddress: Address.nullable(),
    /** As the chain returned it, in `scale` units. */
    rawValue: Digits.nullable(),
    /** Read from `WAD_PRECISION()`, never assumed to be 1e18. */
    scale: Digits.nullable(),
    /** Decimal string, e.g. `1.057380318816778075`. */
    normalized: z
      .string()
      .regex(/^(0|[1-9][0-9]*)\.[0-9]+$/)
      .nullable(),
    oneToOne: z.boolean().nullable(),
    source: z.enum(['b20_asset_multiplier']).nullable(),
    appliedToReference: z.literal(false),
    unavailableReason: z
      .enum(['token_address_unknown', 'not_implemented', 'chain_read_failed', 'answer_unusable'])
      .nullable(),
    evidence: DossierEvidenceRefV1Schema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === 'read' && value.normalized === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['normalized'],
        message: 'a multiplier that was read has a value',
      });
    }
    if (value.status !== 'read' && value.oneToOne !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['oneToOne'],
        message: 'an unread multiplier never claims that one token is one share',
      });
    }
  });
export type RepresentationMultiplierV1 = z.infer<typeof RepresentationMultiplierV1Schema>;

export const ReferenceValueV1Schema = z
  .object({
    status: z.enum(['fresh', 'stale', 'paused', 'unavailable', 'invalid']),
    feedAddress: Address.nullable(),
    valueAtomic: z
      .string()
      .regex(/^-?(0|[1-9][0-9]*)$/)
      .nullable(),
    decimals: z.number().int().min(0).max(36).nullable(),
    feedUpdatedAt: Timestamp.nullable(),
    ageSeconds: z.number().int().min(0).nullable(),
    /** Known for the reviewed Coinbase B20 feed. Null means this issuer's
     * reference model is not established; it never means false by default. */
    totalReturnValue: z.boolean().nullable(),
    multiplierAppliedByFeed: z.boolean().nullable(),
    registryPause: z.enum(['not_paused', 'paused', 'unknown']),
    comparisonEligible: z.boolean(),
    withheldReason: z
      .enum([
        'reference_stale',
        'reference_paused',
        'reference_unavailable',
        'reference_invalid',
        'registry_pause_state_unavailable',
      ])
      .nullable(),
    evidence: DossierEvidenceRefV1Schema.nullable(),
  })
  .strict();
export type ReferenceValueV1 = z.infer<typeof ReferenceValueV1Schema>;

/** The scale every per-token executable price is expressed in, on both the
 * list and the dossier, so the reference comparison has exactly one basis. */
export const PER_TOKEN_PRICE_DECIMALS_V1 = 8;

export const ExecutableValueV1Schema = z
  .object({
    status: z.enum([
      'full',
      'partial',
      'buy_only',
      'unavailable',
      'not_measured',
      'measurement_failed',
    ]),
    valueAtomic: Digits.nullable(),
    decimals: z.number().int().min(0).max(36).nullable(),
    // The per-token price the same measurement implies, and the ONLY basis the
    // reference comparison is allowed to use. `valueAtomic` is whatever the
    // surface displays -- on the list it is the cash a sized rung handed back,
    // which is a total, not a price. Dividing a $100,000 total by a per-share
    // feed is a category error that renders as a 31,015% premium.
    perTokenValueAtomic: Digits.nullable(),
    perTokenDecimals: z.number().int().min(0).max(36).nullable(),
    requestedSizeAtomic: Digits.nullable(),
    executableSizeAtomic: Digits.nullable(),
    destination: z.enum(['USDC', 'ETH']).nullable(),
    observedAt: Timestamp.nullable(),
    evidence: DossierEvidenceRefV1Schema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.perTokenValueAtomic === null) !== (value.perTokenDecimals === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a per-token price and its scale travel together',
        path: ['perTokenDecimals'],
      });
    }
  });
export type ExecutableValueV1 = z.infer<typeof ExecutableValueV1Schema>;

export const ReferenceExecutableComparisonV1Schema = z
  .object({
    status: z.enum(['comparable', 'withheld']),
    differenceBps: z
      .string()
      .regex(/^-?(0|[1-9][0-9]*)$/)
      .nullable(),
    reason: z
      .enum([
        'reference_stale',
        'reference_paused',
        'reference_unavailable',
        'reference_invalid',
        'registry_pause_state_unavailable',
        'executable_value_not_measured',
        'executable_value_unavailable',
        'executable_value_buy_only',
        'executable_value_measurement_failed',
        'executable_value_not_normalized',
      ])
      .nullable(),
  })
  .strict();
export type ReferenceExecutableComparisonV1 = z.infer<typeof ReferenceExecutableComparisonV1Schema>;

export const DossierVenueV1Schema = z
  .object({
    address: Address,
    kind: z.enum(['paired_pool', 'singleton']),
    token0: Address.nullable(),
    token1: Address.nullable(),
    quoteAddress: Address.nullable(),
    quoteCategory: z.enum(['USDC', 'ETH_WETH', 'other_official_asset', 'unknown']).nullable(),
    directCashReachable: z.boolean().nullable(),
    firstSeenAt: Timestamp,
    identifiedAt: Timestamp.nullable(),
  })
  .strict();

export const MarketTopologyV1Schema = z
  .object({
    status: z.enum(['observed', 'unavailable']),
    checkedAt: Timestamp.nullable(),
    checkedThroughBlock: z.number().int().positive().nullable(),
    venueCount: z.number().int().min(0).nullable(),
    pairedPoolCount: z.number().int().min(0).nullable(),
    singletonCount: z.number().int().min(0).nullable(),
    directCashPoolCount: z.number().int().min(0).nullable(),
    directUsdcPoolCount: z.number().int().min(0).nullable(),
    directEthPoolCount: z.number().int().min(0).nullable(),
    venues: z.array(DossierVenueV1Schema).max(1_000),
    evidence: DossierEvidenceRefV1Schema.nullable(),
  })
  .strict();

export const RecentMarketActivityV1Schema = z
  .object({
    status: z.enum(['observed', 'no_movements_observed', 'unavailable']),
    semantics: z.literal('venue_transfers_not_confirmed_swaps'),
    checkedAt: Timestamp.nullable(),
    windowFromBlock: z.number().int().positive().nullable(),
    windowToBlock: z.number().int().positive().nullable(),
    movementCount: z.number().int().min(0).nullable(),
    outOfVenueCount: z.number().int().min(0).nullable(),
    intoVenueCount: z.number().int().min(0).nullable(),
    confirmedSwapCount: z.null(),
    latest: z
      .array(
        z
          .object({
            venueAddress: Address,
            direction: z.enum(['out_of_venue', 'into_venue']),
            counterparty: Address,
            counterpartyRole: z.literal('unattributed_counterparty'),
            amountAtomic: Digits,
            blockNumber: z.number().int().positive(),
            transactionHash: Hash,
            logIndex: z.number().int().min(0),
            observedAt: Timestamp,
          })
          .strict(),
      )
      .max(20),
    evidence: DossierEvidenceRefV1Schema.nullable(),
  })
  .strict();

export const OfficialAssetDossierV1Schema = z
  .object({
    schemaVersion: z.literal('official-asset-dossier/v1'),
    dossierHash: Hash,
    assembly: z.literal('deterministic_no_llm_facts'),
    status: z.enum(['assembled', 'partial']),
    chainId: z.literal(8453),
    tokenAddress: Address,
    assembledAt: Timestamp,
    identity: OfficialDossierIdentityV1Schema,
    referenceValue: ReferenceValueV1Schema,
    // One token is not permanently one share. Read at the same block anchor as
    // the reference, disclosed rather than applied.
    multiplier: RepresentationMultiplierV1Schema,
    executableValue: ExecutableValueV1Schema,
    cashExitLadder: CashExitLadderV1Schema,
    comparison: ReferenceExecutableComparisonV1Schema,
    controls: DossierControlsV1Schema,
    marketTopology: MarketTopologyV1Schema,
    recentMarketActivity: RecentMarketActivityV1Schema,
    gaps: z.array(z.string().min(1).max(120)).max(32),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.dossierHash !== hashOfficialAssetDossierV1(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dossierHash'],
        message: 'dossier hash mismatch',
      });
    }
  });
export type OfficialAssetDossierV1 = z.infer<typeof OfficialAssetDossierV1Schema>;

export const OfficialAssetDossierResponseV1Schema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('dossier'), dossier: OfficialAssetDossierV1Schema }).strict(),
  z
    .object({
      outcome: z.literal('not_in_reviewed_corpus'),
      chainId: z.literal(8453),
      tokenAddress: Address,
      detail: z.string().min(1).max(300),
    })
    .strict(),
]);
export type OfficialAssetDossierResponseV1 = z.infer<typeof OfficialAssetDossierResponseV1Schema>;

export function hashOfficialAssetDossierV1(value: Record<string, unknown>): HashV1 {
  const { dossierHash: _dossierHash, ...content } = value;
  return stableHashV1('official-asset-dossier/v1', content);
}
