import { z } from 'zod';
import {
  AddressV1Schema,
  CommerceInvoiceV1Schema,
  CommerceOrderEventV1Schema,
  CommercePaymentBlueprintV1Schema,
  CommerceOrderV1Schema,
  CommerceRouteCardV1Schema,
  CommerceRouteProofV1Schema,
  EarnRouteCardV1Schema,
  AiInferenceProofV1Schema,
  AiRouteCardV1Schema,
  NftProofFinalStatusV1Schema,
  NftPurchaseBlueprintV1Schema,
  NftPurchaseBlueprintStatusV1Schema,
  NftPurchaseProofV1Schema,
  NftRouteCardV1Schema,
  ExecutionBlueprintV1Schema,
  GasEstimateV1Schema,
  HashV1Schema,
  HexDataV1Schema,
  IntelligenceCategoryV1Schema,
  ProviderRefV1Schema,
  RouteCardV1Schema,
  RouteIntentV1Schema,
  SafetyKernelResultV1Schema,
  SimulationStateV1Schema,
  TransactionReceiptV1Schema,
} from '@mioagent/route-domain';
import { SwapRouteEvaluationV1Schema } from '@mioagent/route-engine/contracts';
import { RoutePlanProjectionV1Schema } from '@mioagent/route-card/contracts';
import { TransactionReviewProjectionV1Schema } from '@mioagent/route-card/transactionReview';
export {
  OfficialAssetDossierResponseV1Schema,
  OfficialAssetDossierV1Schema,
  type OfficialAssetDossierResponseV1,
  type OfficialAssetDossierV1,
} from '@mioagent/rwa-dossier/contracts';
// T-Phase-6 — the three Discover reads. Re-exported rather than restated: the
// projection that assembles them and the schema a client parses them with have
// to be the same object, or a field can be dropped on one side and nobody
// notices until a card renders blank.
export {
  LOOKALIKE_DISCLAIMER_V1,
  OfficialAssetsOverviewV1Schema,
  OfficialAssetSummaryV1Schema,
  OfficialLookalikeCardV1Schema,
  OfficialLookalikeFeedV1Schema,
  RwaSignalCardV1Schema,
  RwaSignalFeedV1Schema,
  RWA_SIGNALS_NOT_REPORTED_V1,
  type OfficialAssetsOverviewV1,
  type OfficialAssetSummaryV1,
  type OfficialLookalikeCardV1,
  type OfficialLookalikeFeedV1,
  type RwaSignalCardV1,
  type RwaSignalFeedV1,
} from '@mioagent/rwa-dossier/discover';
// Phase 10A/10B — one underlying, every reviewed Base representation of it.
// Re-exported rather than restated for the same reason the Discover schemas
// are: the projection that assembles the answer and the schema a client parses
// it with have to be the same object, or a field can be dropped on one side
// and nobody notices until a column renders blank.
export {
  MARKET_REALITY_WINDOW_KEYS_V1,
  MarketRealityIndexV1Schema,
  MarketRealityIndexEntryV1Schema,
  MarketRealityHistoryV1Schema,
  MarketRealityLiveResponseV2Schema,
  MarketRealityMeasurementV1Schema,
  MarketRealityRadarEventV1Schema,
  MarketRealityRadarPublicWatchV1Schema,
  MarketRealityRadarResponseV1Schema,
  MarketRealityRadarWatchInputV1Schema,
  MarketRealityResponseV2Schema,
  type MarketRealityIndexV1,
  type MarketRealityIndexEntryV1,
  type MarketRealityHistoryV1,
  type MarketRealityLiveResponseV2,
  type MarketRealityMeasurementV1,
  type MarketRealityRadarEventV1,
  type MarketRealityRadarResponseV1,
  type MarketRealityRadarWatchInputV1,
  type MarketRealityResponseV2,
} from '@mioagent/rwa-market-reality/contracts';
// Phase 7 — one pasted address. Re-exported rather than restated for the same
// reason the Discover schemas are: the projection that assembles a dossier and
// the schema a client parses it with have to be the same object.
export {
  AddressDossierV1Schema,
  AddressIdentityV1Schema,
  ADDRESS_STANDINGS_V1,
  type AddressDossierV1,
  type AddressIdentityV1,
  type AddressStandingV1,
} from '@mioagent/rwa-dossier/addressDossier';

// Shared
export const PaginationParamsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  cursor: z.string().optional(),
});

const EthereumAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
// Canonical USDC-decimal-string regex — money on the wire is ALWAYS a decimal
// string like "1.5", never an atomic/BigInt amount. Exported (moved up from
// its original spot near the x402 Fuel schemas below) so the T60
// Intelligence Budget schemas can reuse it without duplicating the pattern.
export const UsdcAmountSchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/);

// T61 — Earn Route (Moonwell + Morpho). The compare endpoint returns the full
// EarnRouteCardV1 (APY as integer basis points, amounts atomic — the client
// formats for display). Gated behind MIORAIL_ROUTE_INTELLIGENCE_V1 AND
// MIORAIL_EARN_ROUTE_V1.
export const EarnCompareRequestV1Schema = z
  .object({
    message: z.string().trim().min(1).max(4_000),
    walletAddress: AddressV1Schema,
    requestId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'Invalid earn compare request ID'),
  })
  .strict();

export const EarnCompareResponseV1Schema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('compared'),
      // T62: the persisted earn Route Run the client prepares against. Optional
      // so a caller reading a pre-T62 cached compared response still parses.
      routeRunId: z.string().min(1).max(200).optional(),
      routeCard: EarnRouteCardV1Schema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal('needs_clarification'),
      issues: z.array(z.string().min(1).max(120)),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('unsupported'),
      reason: z.string().min(1).max(200),
    })
    .strict(),
]);

// T62 — Persisted Earn Execution. `earn/prepare` turns the persisted Earn Route
// Card + selected candidate into an exact, safety-validated earn deposit
// Blueprint (USDC approval + Moonwell supply / Morpho ERC-4626 deposit). The
// client supplies NO calldata; the server never signs or broadcasts. Gated on
// MIORAIL_ROUTE_INTELLIGENCE_V1 AND MIORAIL_EARN_ROUTE_V1.
export const EarnPrepareRequestV1Schema = z
  .object({
    routeRunId: z.string().min(1).max(200),
    routeCardHash: HashV1Schema,
    selectedCandidateHash: HashV1Schema,
    walletAddress: AddressV1Schema,
    requestId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'Invalid earn prepare request ID'),
  })
  .strict();

export const EarnPrepareResponseV1Schema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('prepared'),
      blueprint: ExecutionBlueprintV1Schema,
      safety: SafetyKernelResultV1Schema,
    })
    .strict(),
  z.object({ outcome: z.literal('refresh_required'), reason: z.string().min(1).max(500) }).strict(),
  z.object({ outcome: z.literal('expired'), reason: z.string().min(1).max(500) }).strict(),
  z
    .object({
      outcome: z.literal('blocked'),
      reason: z.string().min(1).max(500),
      safety: SafetyKernelResultV1Schema,
    })
    .strict(),
]);

// `earn/blueprints/:id/approve` re-validates the STORED earn Blueprint through
// the EARN Safety Kernel and returns the exact unsigned EIP-5792 batch payload
// for the client's Base Account wallet. Same request/response shapes as the
// swap approve route (the approved payload is goal-agnostic), but the route
// dispatches to the earn kernel by the stored Blueprint's goal.
export const EarnBlueprintApproveRequestV1Schema = z
  .object({
    routeRunId: z.string().min(1).max(200),
    blueprintHash: HashV1Schema,
    walletAddress: AddressV1Schema,
  })
  .strict();

export const EarnBlueprintApproveResponseV1Schema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('approved'),
      payload: z
        .object({
          blueprintId: z.string().min(1).max(200),
          blueprintHash: HashV1Schema,
          approvedCallsHash: HashV1Schema,
          chainId: z.literal('0x2105'),
          from: AddressV1Schema,
          calls: z
            .array(
              z
                .object({
                  to: AddressV1Schema,
                  value: z.string().regex(/^0x[0-9a-f]+$/, 'Expected a hex quantity'),
                  data: HexDataV1Schema,
                })
                .strict(),
            )
            .min(1)
            .max(100),
          atomicRequired: z.literal(true),
        })
        .strict(),
      lifecycle: z.enum([
        'draft',
        'ready_for_review',
        'expired',
        'invalid',
        'approved',
        'submitted',
        'submitted_unknown',
        'confirmed',
        'failed',
        'cancelled',
        'completed',
        'partial_failure',
        'reconciliation_required',
      ]),
    })
    .strict(),
  z.object({ outcome: z.literal('expired'), reason: z.string().min(1).max(500) }).strict(),
  z
    .object({
      outcome: z.literal('blocked'),
      reason: z.string().min(1).max(500),
      safety: SafetyKernelResultV1Schema,
    })
    .strict(),
]);

// T64 — Commerce Route (Bitrefill). `commerce/compare` returns the full
// CommerceRouteCardV1: every denomination that was found, its exact price and
// fee basis, its stock state and its freshness. Gated behind
// MIORAIL_ROUTE_INTELLIGENCE_V1 AND MIORAIL_COMMERCE_ROUTE_V1.
export const CommerceCompareRequestV1Schema = z
  .object({
    message: z.string().trim().min(1).max(4_000),
    walletAddress: AddressV1Schema,
    requestId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'Invalid commerce compare request ID'),
  })
  .strict();

export const CommerceCompareResponseV1Schema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('compared'),
      /** T64.2: the persisted commerce Route Run the client orders against. */
      routeRunId: z.string().min(1).max(200),
      routeCard: CommerceRouteCardV1Schema,
      /** True when the market was inferred from the currency rather than
       * stated. The surface must say so — it is a disclosed assumption. */
      countryInferred: z.boolean(),
      /** Denominations the comparison deliberately excluded, by reason code. */
      excluded: z.array(z.string().min(1).max(60)),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('needs_clarification'),
      issues: z.array(z.string().min(1).max(120)),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('unsupported'),
      reason: z.string().min(1).max(200),
      /** Whether the reviewed catalogue request happened before the terminal
       * result. This is observability, not a candidate or success claim. */
      catalogueStatus: z.enum(['not_reached', 'request_failed', 'reached_no_match', 'reached']),
    })
    .strict(),
]);

// `commerce/orders` opens a price-locked checkout at the storefront and returns
// the exact payment terms for review. It SIGNS NOTHING and PAYS NOTHING: the
// wallet authorizes the x402 payment itself, against exactly these terms.
// Additionally gated behind MIORAIL_COMMERCE_EXECUTION_V1.
export const CommerceOrderCreateRequestV1Schema = z
  .object({
    /** T64.2: the persisted run, not a message. The server loads the stored
     * Route Card rather than re-deriving one, so the price the user reviewed
     * is the price the order is checked against. */
    routeRunId: z.string().min(1).max(200),
    routeCardHash: HashV1Schema,
    selectedCandidateHash: HashV1Schema,
    walletAddress: AddressV1Schema,
    requestId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'Invalid commerce order request ID'),
  })
  .strict();

/** The two amounts, side by side and never merged: what the catalogue
 * estimated, and what the invoice actually requires. */
export const CommerceAmountReviewV1Schema = z
  .object({
    estimatedMinimumAtomic: z.string().regex(/^(0|[1-9]\d*)$/),
    estimatedBasis: z.enum(['exact_quote', 'minimum']),
    exactAmountAtomic: z.string().regex(/^(0|[1-9]\d*)$/),
    exceedsEstimate: z.boolean(),
    differenceAtomic: z.string().regex(/^(0|[1-9]\d*)$/),
  })
  .strict();

export const CommerceOrderCreateResponseV1Schema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('created'),
      orderId: z.string().min(1).max(200),
      order: CommerceOrderV1Schema,
      invoice: CommerceInvoiceV1Schema,
      amounts: CommerceAmountReviewV1Schema,
    })
    .strict(),
  /** The catalogue moved under the selection — re-compare, do not re-price. */
  z.object({ outcome: z.literal('refresh_required'), reason: z.string().min(1).max(500) }).strict(),
  z.object({ outcome: z.literal('blocked'), reason: z.string().min(1).max(500) }).strict(),
  /**
   * The provider call did not return a definite answer. An invoice MAY exist,
   * so this is never retried automatically — the client is told to reconcile,
   * not to try again.
   */
  z
    .object({
      outcome: z.literal('invoice_creation_unknown'),
      orderId: z.string().min(1).max(200),
      reason: z.string().min(1).max(500),
    })
    .strict(),
]);

// `commerce/orders/:invoiceId` reports the order and its three-leg proof.
// A settled payment with no confirmed order is `order_unconfirmed` here — the
// route never reports it as a completed purchase.
export const CommerceOrderStatusResponseV1Schema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('status'),
      orderId: z.string().min(1).max(200),
      order: CommerceOrderV1Schema,
      proof: CommerceRouteProofV1Schema,
      providerStatus: z.string().min(1).max(60),
      events: z.array(CommerceOrderEventV1Schema).max(100),
    })
    .strict(),
  /** A reserved checkout whose invoice was never confirmed. */
  z
    .object({
      outcome: z.literal('creation_unknown'),
      orderId: z.string().min(1).max(200),
      reason: z.string().min(1).max(500),
    })
    .strict(),
  z.object({ outcome: z.literal('unknown_order'), reason: z.string().min(1).max(500) }).strict(),
  z
    .object({ outcome: z.literal('provider_unavailable'), reason: z.string().min(1).max(500) })
    .strict(),
]);

// T64.3 — the payment rail. `prepare` builds the exact call and returns it for
// review; `approve` returns the unsigned wallet payload; `submission` records
// what the wallet did. The server never signs and never broadcasts.
export const CommercePaymentPrepareRequestV1Schema = z
  .object({
    requestId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  })
  .strict();

export const CommercePaymentPrepareResponseV1Schema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('prepared'),
      blueprint: CommercePaymentBlueprintV1Schema,
      safety: SafetyKernelResultV1Schema,
      signable: z.boolean(),
      signableReason: z.string().min(1).max(300).nullable(),
    })
    .strict(),
  /** The invoice moved under the review. No replacement is opened. */
  z.object({ outcome: z.literal('invoice_changed'), reason: z.string().min(1).max(500) }).strict(),
  z.object({ outcome: z.literal('invoice_expired'), reason: z.string().min(1).max(500) }).strict(),
  z
    .object({
      outcome: z.literal('blocked'),
      reason: z.string().min(1).max(500),
      safety: SafetyKernelResultV1Schema.nullable(),
    })
    .strict(),
]);

export const CommercePaymentApproveRequestV1Schema = z
  .object({ blueprintHash: HashV1Schema, walletAddress: AddressV1Schema })
  .strict();

export const CommercePaymentApproveResponseV1Schema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('approved'),
      payload: z
        .object({
          blueprintHash: HashV1Schema,
          approvedCallsHash: HashV1Schema,
          chainId: z.literal('0x2105'),
          from: AddressV1Schema,
          calls: z
            .array(
              z
                .object({
                  to: AddressV1Schema,
                  value: z.string().regex(/^0x[0-9a-f]+$/),
                  data: HexDataV1Schema,
                })
                .strict(),
            )
            .length(1),
        })
        .strict(),
      safety: SafetyKernelResultV1Schema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal('blocked'),
      reason: z.string().min(1).max(500),
      safety: SafetyKernelResultV1Schema.nullable(),
    })
    .strict(),
]);

export const CommercePaymentSubmissionRequestV1Schema = z
  .object({
    blueprintHash: HashV1Schema,
    approvedCallsHash: HashV1Schema,
    walletAddress: AddressV1Schema,
    /** EIP-5792 batch id, when the wallet returned one. */
    batchId: z.string().min(1).max(200).nullable(),
    transactionHash: HashV1Schema.nullable(),
    /** What the wallet reported. `cancelled` is a first-class outcome. */
    walletStatus: z.enum(['submitted', 'cancelled', 'unknown']),
  })
  .strict();

export const CommercePaymentStatusV1Schema = z
  .object({
    blueprintStatus: z.string().min(1).max(60),
    progress: z.string().min(1).max(60).nullable(),
    onchain: z.string().min(1).max(60).nullable(),
    transactionHash: HashV1Schema.nullable(),
    delivery: z
      .object({
        redemptionAvailable: z.boolean(),
        deliveryObservedAt: z.string().min(1).max(60).nullable(),
        orderStatus: z.string().min(1).max(60),
        redactedResponseHash: HashV1Schema.nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const CommercePaymentSubmissionResponseV1Schema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('recorded'), status: CommercePaymentStatusV1Schema }).strict(),
  z.object({ outcome: z.literal('cancelled'), reason: z.string().min(1).max(500) }).strict(),
  z.object({ outcome: z.literal('conflict'), reason: z.string().min(1).max(500) }).strict(),
  z.object({ outcome: z.literal('blocked'), reason: z.string().min(1).max(500) }).strict(),
]);

/** Redemption material. Returned ONCE, over a no-store response, to the wallet
 * that owns the order. It is never persisted and never hashed. */
export const CommerceDeliveryResponseV1Schema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('delivered'),
      orderId: z.string().min(1).max(200),
      deliveryObservedAt: z.string().min(1).max(60),
      fields: z.record(z.string().min(1).max(4_000)),
    })
    .strict(),
  z.object({ outcome: z.literal('not_delivered'), reason: z.string().min(1).max(500) }).strict(),
  z.object({ outcome: z.literal('unknown_order'), reason: z.string().min(1).max(500) }).strict(),
]);

export const CommerceHistoryItemV1Schema = z
  .object({
    orderId: z.string().min(1).max(200),
    invoiceId: z.string().min(1).max(200).nullable(),
    productId: z.string().min(1).max(200),
    packageValue: z.string().min(1).max(80),
    status: z.string().min(1).max(40),
    providerStatus: z.string().min(1).max(40),
    exactAmountAtomic: z
      .string()
      .regex(/^(0|[1-9]\d*)$/)
      .nullable(),
    estimatedAmountAtomic: z
      .string()
      .regex(/^(0|[1-9]\d*)$/)
      .nullable(),
    proofFinalStatus: z.string().min(1).max(40).nullable(),
    createdAt: z.string().min(1).max(60),
    updatedAt: z.string().min(1).max(60),
  })
  .strict();

export const CommerceHistoryResponseV1Schema = z
  .object({ items: z.array(CommerceHistoryItemV1Schema).max(100) })
  .strict();

// Route Intelligence V1 — read-only plan evaluation. These schemas deliberately
// accept no provider artifacts, candidates, scores, execution calls, or client
// chain overrides.
export const RoutePlanRequestV1Schema = z
  .object({
    message: z.string().trim().min(1).max(4_000),
    walletAddress: AddressV1Schema,
    requestId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'Invalid route plan request ID'),
  })
  .strict();

export const IntentIssueV1Schema = z
  .object({
    code: z.enum([
      'amount_required',
      'exact_amount_required',
      'from_asset_required',
      'to_asset_required',
      'asset_pair_invalid',
      'asset_unknown',
      'chain_unsupported',
      'protocol_conflict',
      'slippage_invalid',
      'intent_ambiguous',
      'approval_bypass_forbidden',
      'prompt_injection_detected',
      'server_signing_forbidden',
      'asset_address_unsafe',
      'conflicting_amounts',
      'conflicting_protocol_constraints',
      'unsupported_goal',
      'extractor_invalid',
      'extractor_field_ungrounded',
      'context_ambiguous',
    ]),
    field: z.string().min(1).max(120),
    severity: z.enum(['clarification', 'rejection']),
    message: z.string().min(1).max(500),
  })
  .strict();

export const ClarificationV1Schema = z
  .object({
    code: z.enum([
      'amount_required',
      'exact_amount_required',
      'from_asset_required',
      'to_asset_required',
      'asset_pair_invalid',
      'asset_unknown',
      'chain_unsupported',
      'protocol_conflict',
      'slippage_invalid',
      'intent_ambiguous',
    ]),
    message: z.string().min(1).max(500),
    missingFields: z.array(z.string().min(1).max(120)),
    locale: z.enum(['en', 'ru']),
  })
  .strict();

export const RoutePlanResponseV1Schema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('needs_clarification'),
      clarification: ClarificationV1Schema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal('rejected'),
      issues: z.array(IntentIssueV1Schema).min(1),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('evaluated'),
      routeRunId: z.string().min(1).max(200),
      intent: RouteIntentV1Schema,
      evaluation: SwapRouteEvaluationV1Schema,
      routeCard: RouteCardV1Schema.nullable(),
      projection: RoutePlanProjectionV1Schema,
    })
    .strict(),
]);

export const RoutePlanHttpErrorV1Schema = z
  .object({
    error: z.enum([
      'route_intelligence_disabled',
      'route_storage_unavailable',
      'base_mainnet_required',
      'authentication_required',
      'wallet_mismatch',
      'invalid_route_plan_request',
      'route_plan_evaluation_failed',
      // T56: swap/prepare-specific codes; the flag/auth/wallet/chain/storage
      // codes above are reused as-is by that route's identical guard sequence.
      'invalid_swap_prepare_request',
      'swap_prepare_failed',
      // T57: blueprint approve / submission routes (identical guard sequence;
      // the conflict code maps the composer's submission-conflict rejection).
      'invalid_blueprint_approve_request',
      'blueprint_approve_failed',
      'invalid_blueprint_submission_request',
      'blueprint_submission_failed',
      'blueprint_submission_conflict',
      // T58: route-proof reconciliation + history routes (same guard chain).
      'invalid_route_proof_reconcile_request',
      'route_proof_not_found',
      'route_proof_conflict',
      'route_proof_reconcile_failed',
      'invalid_history_request',
      'history_failed',
      // T59: paid x402 transaction-simulation route. Money is only ever at
      // risk from 'charge_conflict' onward — every code above that point in
      // this list is a pre-payment 4xx/503 (no settlement attempted yet).
      'paid_intelligence_disabled',
      'invalid_simulation_request',
      'blueprint_not_found',
      'blueprint_not_reviewable',
      'blueprint_hash_mismatch',
      'paid_intelligence_unavailable',
      'charge_conflict',
      'payment_missing',
      'payment_replayed',
      'simulation_provider_unavailable',
      'simulation_failed',
      // T60: Intelligence Budget + Spend Permission payment routes (same
      // guard chain, gated on routeIntelligenceV1 && paidIntelligence — no
      // separate flag). 'budget_limit_exceeded'/'budget_simulation_failed'
      // are the only two reachable AFTER a reservation exists; every other
      // code here is pre-reservation (no money at risk yet).
      'intelligence_budget_disabled',
      'invalid_intelligence_budget_request',
      'spend_permission_required',
      'intelligence_budget_exists',
      'intelligence_budget_not_found',
      'intelligence_budget_conflict',
      'budget_limit_exceeded',
      'budget_simulation_failed',
      // T67E §2.2: the read-only charges list. Its own code, because a failed
      // ledger read must not read as a failed charge.
      'intelligence_charges_failed',
    ]),
    code: z.string().min(1).max(120),
  })
  .strict();

// T56 — Transaction Composer. Turns an explicitly selected Route Card
// candidate into a fresh-quoted, safety-validated, persisted
// ExecutionBlueprintV1 with unsigned EIP-5792 calls. The server never signs
// or broadcasts; these schemas deliberately never accept or echo a signed
// transaction, a wallet_sendCalls payload, or an execution receipt.
export const SwapPrepareRequestV1Schema = z
  .object({
    routeRunId: z.string().min(1).max(200),
    routeCardHash: HashV1Schema,
    selectedCandidateHash: HashV1Schema,
    walletAddress: AddressV1Schema,
    requestId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'Invalid swap prepare request ID'),
  })
  .strict();

export const SwapPrepareResponseV1Schema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('prepared'),
      routeRunId: z.string().min(1).max(200),
      blueprint: ExecutionBlueprintV1Schema,
      review: TransactionReviewProjectionV1Schema,
      // T59: the ONLY change this task makes to the prepare response — the
      // x402 price the client would pay to run a real paid simulation
      // against this Blueprint, sourced from env (MIORAIL_SIMULATION_PRICE_USDC),
      // null whenever the paid-simulation feature is unavailable/disabled.
      // Optional so any caller reading a stale cached response before this
      // field existed keeps parsing.
      simulationPriceUsdc: z.string().min(1).max(40).nullable().optional(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('refresh_required'),
      routeRunId: z.string().min(1).max(200),
      reason: z.enum([
        'card_expired',
        'quote_expired',
        'blueprint_expired',
        'fresh_output_below_minimum',
        // T67B.1 — the reviewed route moved. See RefreshReasonV1Schema.
        'route_changed',
      ]),
      detail: z.string().min(1).max(500),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('unsupported'),
      reason: z.enum(['unsupported_pair', 'unsupported_provider', 'unsupported_card_state']),
      detail: z.string().min(1).max(500),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('blocked'),
      routeRunId: z.string().min(1).max(200),
      safety: SafetyKernelResultV1Schema,
      // The simulation state the kernel judged, so the Review screen renders
      // the same fact the refusal was based on. Optional: a client reading a
      // response written before this field existed keeps parsing, and a block
      // for a non-simulation reason carries null.
      simulation: SimulationStateV1Schema.nullable().optional(),
    })
    .strict(),
]);

// T57 — Blueprint approval + Base Account submission record. The approve
// route re-validates the STORED blueprint server-side and returns the exact
// unsigned EIP-5792 batch payload for the client's Base Account wallet; the
// submission route records what the wallet reported. The server never signs
// or broadcasts, and neither schema ever accepts calls/calldata from the
// client.
export const BlueprintLifecycleStateV1Schema = z.enum([
  'draft',
  'ready_for_review',
  'expired',
  'invalid',
  'approved',
  'submitted',
  'submitted_unknown',
  'confirmed',
  'failed',
  'cancelled',
  // T58: reconciliation-terminal lifecycle states.
  'completed',
  'partial_failure',
  'reconciliation_required',
]);

export const SwapBlueprintApproveRequestV1Schema = z
  .object({
    routeRunId: z.string().min(1).max(200),
    blueprintHash: HashV1Schema,
    walletAddress: AddressV1Schema,
  })
  .strict();

export const SwapBlueprintApproveResponseV1Schema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('approved'),
      payload: z
        .object({
          blueprintId: z.string().min(1).max(200),
          blueprintHash: HashV1Schema,
          approvedCallsHash: HashV1Schema,
          chainId: z.literal('0x2105'),
          from: AddressV1Schema,
          calls: z
            .array(
              z
                .object({
                  to: AddressV1Schema,
                  value: z.string().regex(/^0x[0-9a-f]+$/, 'Expected a hex quantity'),
                  data: HexDataV1Schema,
                })
                .strict(),
            )
            .min(1)
            .max(100),
          atomicRequired: z.literal(true),
        })
        .strict(),
      lifecycle: BlueprintLifecycleStateV1Schema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal('expired'),
      reason: z.string().min(1).max(500),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('blocked'),
      reason: z.string().min(1).max(500),
      safety: SafetyKernelResultV1Schema,
    })
    .strict(),
]);

export const SwapBlueprintSubmissionRequestV1Schema = z
  .object({
    routeRunId: z.string().min(1).max(200),
    walletAddress: AddressV1Schema,
    approvedCallsHash: HashV1Schema,
    batchId: z.string().min(1).max(500).optional(),
    status: z.enum(['submitted', 'confirmed', 'failed', 'cancelled', 'submitted_unknown']),
    transactionHashes: z
      .array(z.string().regex(/^0x[0-9a-fA-F]{64}$/))
      .max(100)
      .optional(),
    receipts: z.array(z.unknown()).max(100).optional(),
    error: z.string().max(1000).optional(),
    /** T67C.2: the recovery attempt this record belongs to, when one was
     * opened. Optional so every pre-T67C.2 client keeps working unchanged. It
     * grants nothing on its own — the server re-checks that the attempt is this
     * tenant's, is bound to this blueprint and names these approved calls, and
     * refuses the whole record otherwise. */
    submissionAttemptId: z.string().min(1).max(200).optional(),
  })
  .strict()
  // A record that claims the wallet accepted the batch (submitted / confirmed /
  // submitted_unknown) MUST carry the batch id the wallet returned. Without it
  // the server would mutate the pending Route Proof (tx hashes / receipts) with
  // no corresponding `submitted`/`receipt_observed` event, corrupting the
  // append-only audit chain. `batchId` may be absent ONLY for a terminal
  // failed/cancelled record describing a transport failure or wallet refusal
  // that happened before any batch id was assigned.
  .superRefine((value, ctx) => {
    const batchBound =
      value.status === 'submitted' ||
      value.status === 'confirmed' ||
      value.status === 'submitted_unknown';
    if (batchBound && (value.batchId === undefined || value.batchId.trim().length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['batchId'],
        message: `batchId is required for a ${value.status} submission record`,
      });
    }
  });

export const SwapBlueprintSubmissionResponseV1Schema = z
  .object({
    outcome: z.literal('recorded'),
    lifecycle: BlueprintLifecycleStateV1Schema,
    proofId: z.string().min(1).max(200),
    finalStatus: z.enum([
      'pending',
      'completed',
      'partial_failure',
      'failed',
      'cancelled',
      'reconciliation_required',
    ]),
  })
  .strict();

// T58 — Route Proof reconciliation + history. The reconcile route verifies
// onchain receipts through a server-side, env-configured public client (never
// request-supplied RPC) and honestly finalizes the proof; GET routes are pure
// reads. The server never signs or broadcasts; unknown never becomes success.
export const RouteProofReconcileRequestV1Schema = z
  .object({
    routeRunId: z.string().min(1).max(200),
    walletAddress: AddressV1Schema,
  })
  .strict();

export const RouteProofProjectionV1Schema = z
  .object({
    proofId: z.string().min(1).max(200),
    blueprintId: z.string().min(1).max(200),
    blueprintHash: HashV1Schema,
    approvedCallsHash: HashV1Schema,
    intentHash: HashV1Schema,
    provider: z.string().min(1).max(120).nullable(),
    expectedOutput: z
      .object({
        amountAtomic: z.string(),
        asset: z
          .object({
            symbol: z.string(),
            decimals: z.number().int(),
            address: z.string().nullable(),
            kind: z.enum(['native', 'erc20']),
          })
          .strict(),
      })
      .strict(),
    minimumOutput: z.string().nullable(),
    actualOutput: z.string().nullable(),
    /** Why `actualOutput` is null even though the chain has answered. A native
     * output emits no ERC-20 Transfer log, so the amount cannot be read from
     * the receipt and Miorail declines to invent one. Derived server-side from
     * the proof itself — see lib/route-proof/src/projection.ts. */
    actualOutputUnavailableReason: z
      .enum(['native_output_unverifiable', 'not_reconciled'])
      .nullable(),
    outputDeviationBps: z.number().int().nullable(),
    minimumSatisfied: z.boolean().nullable(),
    estimatedGas: GasEstimateV1Schema,
    actualGas: GasEstimateV1Schema.nullable(),
    transactionHashes: z.array(HashV1Schema),
    receipts: z.array(TransactionReceiptV1Schema),
    finalStatus: z.enum([
      'pending',
      'completed',
      'partial_failure',
      'failed',
      'cancelled',
      'reconciliation_required',
    ]),
    reconciliationState: z.enum([
      'pending',
      'matched',
      'deviated',
      'partial',
      'failed',
      'manual_review',
    ]),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const RouteProofReconcileResponseV1Schema = z
  .object({
    outcome: z.enum([
      'pending',
      'completed',
      'partial_failure',
      'failed',
      'reconciliation_required',
      'already_finalized',
    ]),
    proof: RouteProofProjectionV1Schema,
    lifecycle: BlueprintLifecycleStateV1Schema,
  })
  .strict();

export const RouteProofGetResponseV1Schema = z
  .object({
    proof: RouteProofProjectionV1Schema,
    lifecycle: BlueprintLifecycleStateV1Schema,
    // User-safe event history: index/type/time only, never payloads.
    events: z.array(
      z
        .object({
          eventIndex: z.number().int().nonnegative(),
          eventType: z.string().min(1).max(60),
          createdAt: z.string().datetime({ offset: true }),
        })
        .strict(),
    ),
  })
  .strict();

export const RouteHistoryItemV1Schema = z
  .object({
    routeRunId: z.string().min(1).max(200),
    createdAt: z.string().datetime({ offset: true }),
    runStatus: z.string().min(1).max(60),
    intentHash: HashV1Schema,
    intentSummary: z.string().min(1).max(300),
    blueprintId: z.string().min(1).max(200).nullable(),
    blueprintStatus: z.string().min(1).max(60).nullable(),
    proofId: z.string().min(1).max(200).nullable(),
    proofFinalStatus: z.string().min(1).max(60).nullable(),
    reconciliationState: z.string().min(1).max(60).nullable(),
    provider: z.string().min(1).max(120).nullable(),
  })
  .strict();

export const RouteHistoryRequestV1Schema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).optional().default(20),
    cursor: z.string().min(1).max(2000).optional(),
  })
  .strict();

export const RouteHistoryResponseV1Schema = z
  .object({
    items: z.array(RouteHistoryItemV1Schema),
    nextCursor: z.string().nullable(),
  })
  .strict();

// T59 — First Paid x402 Simulation Enrichment. calldata is NEVER accepted
// from the client: the server re-fetches the ALREADY-persisted Blueprint's
// calls and re-derives everything from there. The server never signs or
// broadcasts, and Safety Score stays "No data — no score" (transactionSafety
// is always the literal 'not_scored').
export const SimulateBlueprintRequestV1Schema = z
  .object({
    routeRunId: z.string().min(1).max(200),
    walletAddress: AddressV1Schema,
    blueprintHash: HashV1Schema,
    idempotencyKey: z.string().min(8).max(100),
  })
  .strict();

const SimulateStateChangeV1Schema = z
  .object({
    address: AddressV1Schema,
    kind: z.enum(['balance', 'storage', 'token']),
    summary: z.string().min(1).max(500),
  })
  .strict();

const SimulateEvidenceSummaryV1Schema = z
  .object({
    evidenceHash: HashV1Schema,
    evidenceSetHash: HashV1Schema,
    blockNumber: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .nullable(),
    gasUsed: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .nullable(),
    stateChanges: z.array(SimulateStateChangeV1Schema),
    provider: ProviderRefV1Schema,
    paidCostUsdc: z.string().min(1).max(40),
    x402TxHash: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .nullable(),
  })
  .strict();

const SimulateChargeSummaryV1Schema = z
  .object({
    chargeId: z.string().min(1).max(200),
    status: z.enum([
      'quoted',
      'reserved',
      'payment_pending',
      'settled',
      'failed',
      'reconciliation_required',
      'released',
    ]),
    paymentState: z.enum(['not_started', 'reserved', 'pending', 'settled', 'failed']),
    serviceState: z.enum(['not_started', 'pending', 'delivered', 'invalid', 'failed']),
  })
  .strict();

// transaction_safety is ALWAYS the literal 'not_scored' — T59 explicitly does
// not implement a numeric transaction-safety score (that requires a
// contract-risk provider, out of scope; see the task boundaries).
const SimulateScoreNoteV1Schema = z
  .object({
    transactionSafety: z.literal('not_scored'),
    missingEvidence: z.array(
      z.enum([
        'quote',
        'liquidity',
        'contract_risk',
        'token_risk',
        'simulation',
        'gas',
        'provider_reliability',
        'mev_protection',
      ]),
    ),
  })
  .strict();

const SimulateSuccessFieldsV1 = {
  simulation: SimulationStateV1Schema,
  evidence: SimulateEvidenceSummaryV1Schema,
  charge: SimulateChargeSummaryV1Schema,
  review: TransactionReviewProjectionV1Schema,
  scoreNote: SimulateScoreNoteV1Schema,
} as const;

export const SimulateBlueprintResponseV1Schema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('simulated'), ...SimulateSuccessFieldsV1 }).strict(),
  z.object({ outcome: z.literal('cached'), ...SimulateSuccessFieldsV1 }).strict(),
  z
    .object({
      outcome: z.literal('paid_service_failed'),
      charge: SimulateChargeSummaryV1Schema,
      reason: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('invalid_response'),
      charge: SimulateChargeSummaryV1Schema,
      reason: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('blueprint_expired'),
      reason: z.string().min(1).max(500),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('blocked'),
      // Matches SafetyKernelResultV1's own blockedReason max (500) — this
      // reason is frequently derived straight from safety.blockedReason.
      reason: z.string().min(1).max(500),
      safety: SafetyKernelResultV1Schema,
    })
    .strict(),
]);

// T60 — Intelligence Budget + Spend Permission payments. A Budget binds an
// ALREADY-existing, active onchain Spend Permission to monthly + per-call
// USDC limits; [Use Intelligence Budget] then pays for a simulation WITHOUT
// a new wallet signature. Every amount on the wire is a decimal USDC string
// (never atomic/BigInt); the user-safe projection deliberately omits
// tenantId and every internal hash. The [Pay once] (T59) surface above is
// untouched and keeps working independently.
export const IntelligenceBudgetProjectionV1Schema = z
  .object({
    budgetId: z.string().min(1).max(200),
    status: z.enum(['active', 'paused', 'revoked', 'expired']),
    periodType: z.literal('monthly'),
    monthlyLimitUsdc: UsdcAmountSchema,
    spentUsdc: UsdcAmountSchema,
    reservedUsdc: UsdcAmountSchema,
    remainingUsdc: UsdcAmountSchema,
    maxPerRequestUsdc: UsdcAmountSchema,
    allowedCategories: z.array(IntelligenceCategoryV1Schema).min(1),
    linkedSpendPermissionId: z.string().min(1).max(300),
    periodStartedAt: z.string().datetime({ offset: true }).nullable(),
    periodEndsAt: z.string().datetime({ offset: true }).nullable(),
    chainId: z.literal(8453),
    walletAddress: AddressV1Schema,
  })
  .strict();

// Create requires the wallet explicitly (matching the guard chain's own
// wallet-mismatch check on a NEW binding); update/revoke operate on "the
// caller's own current active budget" and never re-accept a wallet or ID.
export const CreateIntelligenceBudgetRequestV1Schema = z
  .object({
    spendPermissionId: z.string().min(1).max(300),
    walletAddress: AddressV1Schema,
    periodLimitUsdc: UsdcAmountSchema,
    maxPerCallUsdc: UsdcAmountSchema,
    allowedCategories: z
      .array(IntelligenceCategoryV1Schema)
      .min(1)
      .max(IntelligenceCategoryV1Schema.options.length),
  })
  .strict();

export const UpdateIntelligenceBudgetRequestV1Schema = z
  .object({
    periodLimitUsdc: UsdcAmountSchema.optional(),
    maxPerCallUsdc: UsdcAmountSchema.optional(),
    allowedCategories: z
      .array(IntelligenceCategoryV1Schema)
      .min(1)
      .max(IntelligenceCategoryV1Schema.options.length)
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.periodLimitUsdc === undefined &&
      value.maxPerCallUsdc === undefined &&
      value.allowedCategories === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'At least one of periodLimitUsdc, maxPerCallUsdc, or allowedCategories must be provided',
      });
    }
  });

export const RevokeIntelligenceBudgetRequestV1Schema = z.object({}).strict();

// ---------------------------------------------------------------------------
// T71 — Base Spend Permission onboarding.
//
// Two endpoints, and the split between them is the whole security argument.
//
// PREPARE tells the client what to ask the wallet for. Every field in the
// response is resolved by the SERVER — the spender from the operator's
// configuration, the token from canonical USDC, the chain from a constant, the
// allowance from the limit the user chose. The client is a courier.
//
// CONFIRM carries back what the wallet actually signed. The server does not
// trust a single field of it: the permission hash is recomputed on-chain, the
// binding is re-checked against server-held values, and the chain is asked
// whether it has ever heard of the thing. Only then does a record exist.
//
// There is no endpoint in between, and no shape by which a client can name a
// spender, a token, a chain, a wallet or a permission hash and have it
// believed.
// ---------------------------------------------------------------------------

export const PrepareSpendPermissionRequestV1Schema = z
  .object({
    /** The monthly ceiling the user chose. Bounds the allowance requested. */
    periodLimitUsdc: UsdcAmountSchema,
    maxPerCallUsdc: UsdcAmountSchema,
    allowedCategories: z
      .array(IntelligenceCategoryV1Schema)
      .min(1)
      .max(IntelligenceCategoryV1Schema.options.length)
      .optional(),
  })
  .strict();

export const PrepareSpendPermissionResponseV1Schema = z
  .object({
    /** Everything below is the SERVER's answer, to be passed to the wallet
     * unchanged. A client that alters any of it produces a permission that
     * fails verification at confirm time. */
    account: AddressV1Schema,
    spender: AddressV1Schema,
    token: AddressV1Schema,
    chainId: z.literal(8453),
    /** Base-10 atomic USDC. */
    allowanceAtomic: z.string().regex(/^[0-9]{1,30}$/),
    periodInDays: z.number().int().min(28).max(366),
    /** The three sentences shown before the wallet opens. */
    consent: z.array(z.string().min(1).max(300)).min(1).max(6),
    /** Named, never addressed: a raw address in a consent dialog is something
     * nobody verifies and everybody skips. */
    recipientLabel: z.string().min(1).max(120),
  })
  .strict();

/** Exactly what `requestSpendPermission` returns, plus the limits the budget is
 * to be created with. Nothing here is trusted; it is all re-derived. */
export const ConfirmSpendPermissionRequestV1Schema = z
  .object({
    permission: z
      .object({
        signature: z
          .string()
          .regex(/^0x[0-9a-fA-F]+$/)
          .max(4000),
        chainId: z.number().int(),
        permissionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
        permission: z
          .object({
            account: AddressV1Schema,
            spender: AddressV1Schema,
            token: AddressV1Schema,
            allowance: z.string().regex(/^[0-9]{1,40}$/),
            period: z.number().int().positive(),
            start: z.number().int().nonnegative(),
            end: z.number().int().nonnegative(),
            // The salt is a uint256, and wallets disagree about how to write
            // one. `@base-org/account` emits 32 random bytes as a hex string
            // (`createSpendPermissionTypedData` -> `getRandomHexString(32)`);
            // a decimal is equally valid. Both forms are accepted and NEITHER
            // is rewritten: the salt is part of the hash preimage, so the exact
            // characters the wallet signed have to survive to the contract.
            //
            // This regex used to be decimal-only, which meant no permission a
            // Base Account ever produced could be confirmed — every real grant
            // died in `safeParse` before the chain was asked anything.
            salt: z.string().regex(/^(?:0x[0-9a-fA-F]{1,64}|[0-9]{1,80})$/),
            extraData: z
              .string()
              .regex(/^0x[0-9a-fA-F]*$/)
              .max(4000),
          })
          .strict(),
      })
      .strict(),
    periodLimitUsdc: UsdcAmountSchema,
    maxPerCallUsdc: UsdcAmountSchema,
    allowedCategories: z
      .array(IntelligenceCategoryV1Schema)
      .min(1)
      .max(IntelligenceCategoryV1Schema.options.length)
      .optional(),
  })
  .strict();

/** Why a confirmation did not produce a budget. Every one of these means
 * NOTHING was stored and NOTHING was charged. */
export const SpendPermissionRefusalV1Schema = z.enum([
  'malformed_permission',
  'signature_missing',
  'permission_hash_mismatch',
  'wallet_mismatch',
  'chain_mismatch',
  'token_mismatch',
  'spender_mismatch',
  'allowance_below_limit',
  'period_too_short',
  'not_started',
  'already_expired',
  'not_approved_onchain',
  'permission_revoked',
  'permission_inactive',
  'remaining_below_limit',
]);

export const ConfirmSpendPermissionResponseV1Schema = z
  .object({
    outcome: z.enum(['activated', 'refused', 'verification_unavailable']),
    /** Present only on `refused`. */
    refusal: SpendPermissionRefusalV1Schema.nullable(),
    /** One sentence for the user. Never a raw provider message. */
    detail: z.string().min(1).max(400),
    /** Whether trying again could plausibly work. `not_approved_onchain` and a
     * transport failure are retryable; a wrong token never is. */
    retryable: z.boolean(),
    budget: IntelligenceBudgetProjectionV1Schema.nullable(),
  })
  .strict();

export const PauseIntelligenceBudgetRequestV1Schema = z.object({}).strict();

// T67E §2.2 — the Recent charges list for the Budget & payments drawer.
//
// What is deliberately NOT here: the x402 payment authorization payload, the
// facilitator response, the receipt body, the provider's answer, and any
// credential. A charge row says what was bought, what it cost, whether it
// settled and whether it needs reconciliation. Everything a user needs to
// recognise a line on their own budget, and nothing that would let this
// endpoint become a way to read a payment envelope back out of the server.
export const IntelligenceChargeSummaryV1Schema = z
  .object({
    chargeId: z.string().min(1).max(200),
    status: z.enum([
      'quoted',
      'reserved',
      'payment_pending',
      'settled',
      'failed',
      'reconciliation_required',
      'released',
    ]),
    /** What was bought, in words: "Alchemy simulation", "Contract evidence". */
    service: z.string().min(1).max(200),
    providerName: z.string().min(1).max(200),
    category: IntelligenceCategoryV1Schema,
    /** What it was quoted at, and what was actually charged. Both, because a
     * settled charge for less than its quote is a fact worth seeing. */
    quotedUsdc: UsdcAmountSchema,
    chargedUsdc: UsdcAmountSchema.nullable(),
    fundingMode: z.enum(['one_time', 'spend_permission']),
    createdAt: z.string().min(1).max(60),
  })
  .strict();

export const IntelligenceChargesResponseV1Schema = z
  .object({ charges: z.array(IntelligenceChargeSummaryV1Schema).max(100) })
  .strict();

// Serves GET (budget is null when the caller has none), and POST/PATCH/revoke
// (budget is always present on success).
export const IntelligenceBudgetResponseV1Schema = z
  .object({
    budget: IntelligenceBudgetProjectionV1Schema.nullable(),
  })
  .strict();

// The client never supplies provider URL/calldata/price/spender/recipient —
// everything else comes from server config + the already-persisted
// Blueprint. No x402 challenge is ever issued on this route.
export const SimulateWithBudgetRequestV1Schema = z
  .object({
    routeRunId: z.string().min(1).max(200),
    walletAddress: AddressV1Schema,
    blueprintHash: HashV1Schema,
    requestId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'Invalid simulate-with-budget request ID'),
  })
  .strict();

const SimulateWithBudgetChargeSummaryV1Schema = z
  .object({
    chargeId: z.string().min(1).max(200),
    status: z.enum([
      'quoted',
      'reserved',
      'payment_pending',
      'settled',
      'failed',
      'reconciliation_required',
      'released',
    ]),
  })
  .strict();

export const SimulateWithBudgetResponseV1Schema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('charged'),
      // Full parity with the T59 'simulated' response so the surface can
      // reuse the SAME DeepVerificationResultV1 mapping — simulation state and
      // scoreNote (transaction_safety always 'not_scored') included.
      simulation: SimulationStateV1Schema,
      review: TransactionReviewProjectionV1Schema,
      evidence: SimulateEvidenceSummaryV1Schema,
      charge: SimulateWithBudgetChargeSummaryV1Schema,
      scoreNote: SimulateScoreNoteV1Schema,
      budget: IntelligenceBudgetProjectionV1Schema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal('reconciliation_required'),
      charge: SimulateWithBudgetChargeSummaryV1Schema,
      budget: IntelligenceBudgetProjectionV1Schema,
      reason: z.string().min(1).max(500),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('provider_failed'),
      charge: SimulateWithBudgetChargeSummaryV1Schema,
      reason: z.string().min(1).max(500),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('limit_exceeded'),
      reason: z.string().min(1).max(500),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('blocked'),
      reason: z.string().min(1).max(500),
    })
    .strict(),
]);

// Auth
export const LoginRequestSchema = z.object({
  message: z.string(),
  signature: z.string(),
});

export const LoginResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    address: z.string(),
    chainId: z.literal(8453),
  }),
});

export const SessionResponseSchema = z.object({
  user: z
    .object({
      id: z.string(),
      address: z.string(),
      chainId: z.literal(8453),
    })
    .nullable(),
});

export const WalletChallengeRequestSchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});

export const WalletChallengeResponseSchema = z.object({
  nonce: z.string(),
  message: z.string(),
  expiresAt: z.string(),
  chainId: z.literal(8453),
});

// Chat
export const ChatMessageRequestSchema = z.object({
  message: z.string().min(1),
  chatId: z.string().optional(),
  walletAddress: z.string().optional(),
  chainEnv: z.string().optional(),
});

export const ChatMessageResponseSchema = z.object({
  chatId: z.string(),
  messageId: z.string(),
  content: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  createdAt: z.string(),
  actionId: z.string().optional(),
  toolCalls: z.array(z.record(z.any())).optional(),
  metadata: z.record(z.any()).optional(),
});

export const ChatHistoryResponseSchema = z.object({
  messages: z.array(ChatMessageResponseSchema),
  nextCursor: z.string().optional(),
});

export const ChatReconcileResponseSchema = z.object({
  messages: z.array(ChatMessageResponseSchema),
  polledCount: z.number().int().nonnegative(),
  updatedCount: z.number().int().nonnegative(),
  autonomy: z.object({
    spentTodayUsdc: z.string(),
    reservedTodayUsdc: z.string(),
  }),
});

export const ChatListResponseSchema = z.object({
  chats: z.array(
    z.object({
      id: z.string(),
      title: z.string().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
  ),
  nextCursor: z.string().optional(),
});

// Actions
// T19.1: the only onchain action types the user-confirmed flow may surface in
// production. `revoke_approval` (ERC-20 approve(spender,0)) is the preferred
// first mainnet action — no funds move. `limited_transfer` is a bounded USDC
// transfer (capped server-side by MAX_LIMITED_TRANSFER_USDC). Anything else
// stays a read-only recommendation with no confirm button.
// T44b: moonwell_* verbs join the whitelist. Their calldata is validated by a
// dedicated strict guard (lib/security moonwellGuard) fed exclusively from the
// server-stored action payload — never from client input.
export const ProductionActionTypeSchema = z.enum([
  'revoke_approval',
  'limited_transfer',
  'moonwell_supply',
  'moonwell_withdraw',
  'moonwell_borrow',
  'moonwell_repay',
  'uniswap_swap',
]);
export type ProductionActionType = z.infer<typeof ProductionActionTypeSchema>;
export const PRODUCTION_ACTION_TYPES =
  ProductionActionTypeSchema.options as readonly ProductionActionType[];
export function isProductionActionType(t?: string | null): t is ProductionActionType {
  return (PRODUCTION_ACTION_TYPES as readonly string[]).includes(String(t || ''));
}

export const ExecutionPayloadSchema = z.object({
  chain: z.string(),
  // T19.1: present only for whitelisted production action types; absent on
  // read-only plans. The UI gates the confirm button on isProductionActionType.
  actionType: ProductionActionTypeSchema.optional(),
  calls: z.array(
    z.object({
      to: z.string(),
      value: z.string().optional(),
      data: z.string().optional(),
    }),
  ),
});

export const ActionResponseSchema = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.enum([
    'pending',
    'pending_confirmation',
    'submitted_unknown',
    'executed',
    'dismissed',
    'failed',
    'cancelled',
  ]),
  suggestedPrompt: z.string().nullable(),
  tokens: z.array(z.string()).optional(),
  executionPayload: ExecutionPayloadSchema.optional().nullable(),
  metadata: z.record(z.any()).optional().nullable(),
  txHash: z.string().optional(),
  batchId: z.string().optional(),
  receipts: z.array(z.record(z.any())).optional(),
  createdAt: z.string(),
  executedAt: z.string().nullable(),
});

export const ActionsFeedResponseSchema = z.object({
  actions: z.array(ActionResponseSchema),
  nextCursor: z.string().optional(),
});

export const ExecuteActionRequestSchema = z.object({
  actionId: z.string(),
});

export const ExecuteActionResponseSchema = z.object({
  success: z.boolean(),
  txHash: z.string().optional(),
  requestId: z.string().optional(),
  approvalUrl: z.string().optional(),
  error: z.string().optional(),
});

// T19: user-confirmed flow. `prepare` returns an UNSIGNED EIP-5792 payload the
// client submits via Base Account `wallet_sendCalls`. The server never
// broadcasts and never reads MAINNET_EXECUTION_ENABLED for these routes.
export const SecurityScreeningSchema = z.object({
  screenedAt: z.string(),
  allowed: z.boolean(),
  verdict: z.string(),
  reason: z.string().optional(),
  checks: z.array(z.object({ name: z.string(), status: z.string() })).optional(),
});

export const SimulationResultSchema = z.object({
  performed: z.boolean().optional(),
  success: z.boolean(),
  allowed: z.boolean(),
  riskLevel: z.string(),
  reason: z.string().optional(),
  error: z.string().optional(),
  estimatedGas: z.string().optional(),
  expectedOutput: z.string().optional(),
  checks: z.array(z.string()),
  method: z.string().optional(),
  projections: z
    .array(
      z.object({
        kind: z.string(),
        token: z.string(),
        spender: z.string().optional(),
        recipient: z.string().optional(),
        amountRaw: z.string().optional(),
        allowanceAfter: z.string().optional(),
        balanceDelta: z.string().optional(),
      }),
    )
    .optional(),
});

export const PrepareActionRequestSchema = z.object({
  actionId: z.string(),
  walletAddress: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
});

export const PrepareActionResponseSchema = z.object({
  success: z.boolean(),
  actionId: z.string(),
  // EIP-5792 batch target. Base Mainnet = '0x2105'.
  chainId: z.string(),
  from: z.string().nullable().optional(),
  calls: z.array(
    z.object({
      to: z.string(),
      value: z.string().optional(),
      data: z.string().optional(),
    }),
  ),
  atomicRequired: z.boolean(),
  // T19.1: the whitelisted action type this batch encodes (revoke_approval |
  // limited_transfer). The client gates the confirm button on this.
  actionType: ProductionActionTypeSchema.optional(),
  // Live-rederived verdicts (advisory echo; the route re-runs both and gates on them).
  screening: SecurityScreeningSchema,
  simulation: SimulationResultSchema,
  // True when a Builder Code dataSuffix will be attached client-side.
  builderCodeAttached: z.boolean(),
  executionMode: z.enum(['manual-approval', 'bounded-approval']).optional(),
  requiresUserApproval: z.boolean().optional(),
  autonomy: z
    .object({
      reservationId: z.string(),
      amountUsdc: z.number(),
      reservedTodayUsdc: z.number(),
      dailyLimitUsdc: z.number(),
      expiresAt: z.string(),
    })
    .optional(),
  guard: z
    .object({
      code: z.string(),
      contractSecurity: z.object({
        required: z.boolean(),
        status: z.enum(['passed', 'warning', 'blocked', 'skipped']),
        provider: z.string(),
        checkedAddresses: z.array(z.string()),
        warnings: z.array(z.string()),
      }),
    })
    .optional(),
  error: z.string().optional(),
});

export const ConfirmActionRequestSchema = z.object({
  actionId: z.string(),
  // EIP-5792 batch id returned by wallet_sendCalls. Can be empty string/null if failed/cancelled before batch id assignment.
  batchId: z.string().nullable().optional().default(''),
  // EIP-5792 status code (200 = success, 400/500/600 = failure, 4001 = cancelled, 102 = pending_confirmation).
  status: z.number(),
  txHash: z.string().nullable().optional(),
  receipts: z.array(z.record(z.any())).nullable().optional(),
  proof: z.record(z.any()).nullable().optional(),
  error: z.string().nullable().optional(),
});

export const ConfirmActionResponseSchema = z.object({
  success: z.boolean(),
  status: z.enum(['executed', 'failed', 'pending_confirmation', 'submitted_unknown', 'cancelled']),
  txHash: z.string().nullable().optional(),
  error: z.string().optional(),
});

export const BaseMcpToolProbeResponseSchema = z.object({
  status: z.enum(['connected', 'needs_reauth', 'unreachable', 'degraded']),
  endpointHost: z.string().optional(),
  toolsCount: z.number(),
  capabilities: z.object({
    readOnly: z.number(),
    userConfirmedTransaction: z.number(),
    forbidden: z.number(),
    unknown: z.number(),
  }),
  routing: z
    .object({
      read: z.number(),
      action: z.number(),
      routable: z.number(),
      blocked: z.number(),
    })
    .default({ read: 0, action: 0, routable: 0, blocked: 0 }),
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
      capability: z.enum(['read_only', 'user_confirmed_transaction', 'forbidden', 'unknown']),
      scope: z.enum(['wallet', 'protocol']),
      enabled: z.boolean(),
      reason: z.string(),
      surface: z.enum(['read', 'action', 'routable', 'blocked']).optional(),
      surfaceEnabled: z.boolean().optional(),
      surfaceReason: z.string().optional(),
    }),
  ),
  checkedAt: z.string(),
  errorCode: z.string().optional(),
  protocolToolsStatus: z.enum(['available', 'unavailable']).optional(),
  walletToolsStatus: z.enum(['available', 'unavailable']).optional(),
});

// The native Base MCP plugin catalogue, plus whether it has fallen behind the
// one Base publishes. Deliberately separate from the tool probe: the tools are
// a live authenticated read of mcp.base.org, the plugins are published specs
// that exist whether or not this user has ever connected.
export const BaseMcpPluginCatalogueResponseSchema = z.object({
  plugins: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      summary: z.string(),
      version: z.string(),
      integration: z.string(),
      chains: z.array(z.string()),
      tags: z.array(z.string()),
      risk: z.array(z.string()),
      auth: z.string(),
      shell: z.string(),
      hosts: z.array(z.string()),
      externalMcpHost: z.string().nullable(),
      cliPackage: z.string().nullable(),
      productSurface: z.enum(['routes', 'extensions']),
      lifecycleStage: z.enum(['documented', 'manifested', 'adapter', 'scored', 'proven']),
      examples: z
        .array(
          z.object({
            id: z.string().min(1).max(80),
            prompt: z.string().min(1).max(500),
            surface: z.enum(['read', 'action', 'routable']),
            disposition: z.enum([
              'read_in_extensions',
              'handoff_to_routes',
              'handoff_to_provider_ui',
              'typed_x402_required',
              'action_in_extensions',
              // The adapter exists and this runtime cannot finish the journey.
              // Distinct from `adapter_required`, which says nobody wrote it.
              'route_unavailable_here',
              'adapter_required',
            ]),
            /** Why, when the runtime downgraded a declared disposition. */
            capabilityReason: z.string().min(1).max(400).nullable().optional(),
          }),
        )
        .min(1)
        .max(12),
    }),
  ),
  /** The date the committed catalogue was read from Base. */
  generatedAt: z.string(),
  drift: z.object({
    status: z.enum(['in_sync', 'drifted', 'unchecked']),
    knownCount: z.number(),
    publishedCount: z.number().nullable(),
    added: z.array(z.string()),
    removed: z.array(z.string()),
    checkedAt: z.string().nullable(),
    reason: z.string().nullable(),
  }),
});

// The Base MCP console — an AI thread whose entire tool inventory is Base MCP,
// kept apart from Miorail's own routers. Reads use the bounded agent; exact
// typed actions are intercepted before it and use the approval lifecycle.
export const BaseMcpConsoleRequestV1Schema = z.object({
  message: z.string().min(1).max(2000),
  /** Client-generated idempotency handle. Required for action intents, kept
   * optional so old read-only clients remain wire-compatible. */
  requestId: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
    .optional(),
});

export const BaseMcpActionReceiptStatusV1Schema = z.enum([
  'preparing',
  'approval_required',
  'pending',
  'reconciling',
  'completed',
  'rejected',
  'failed',
]);

export const BaseMcpActionReconciliationStateV1Schema = z.enum([
  'not_started',
  'pending',
  'matched',
  'provider_confirmed',
  'mismatched',
  'unavailable',
]);

const BaseMcpActionReceiptCommonV1Schema = z.object({
  schemaVersion: z.literal('base-mcp-action-receipt/v1'),
  id: z.string().min(1).max(200),
  actionHash: HashV1Schema,
  provider: z.literal('base-mcp'),
  chainId: z.literal(8453),
  walletAddress: AddressV1Schema,
  status: BaseMcpActionReceiptStatusV1Schema,
  capabilityPolicy: z.literal('passed'),
  approvalRequired: z.boolean(),
  reconciliationState: BaseMcpActionReconciliationStateV1Schema,
  transactionHash: HashV1Schema.nullable(),
  blockNumber: z.string().regex(/^\d+$/).nullable(),
  errorCode: z.string().min(1).max(120).nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  finalizedAt: z.string().min(1).nullable(),
  /** Explicit semantic boundary: this receipt is not a Route Proof. */
  routeVerified: z.literal(false),
});

export const BaseMcpSendActionReceiptV1Schema = BaseMcpActionReceiptCommonV1Schema.extend({
  approvalRequired: z.literal(true),
  actionType: z.literal('send'),
  asset: z.object({
    symbol: z.literal('USDC'),
    address: AddressV1Schema,
    decimals: z.literal(6),
  }),
  amount: UsdcAmountSchema.refine((value) => Number(value) > 0, 'Amount must be positive'),
  recipient: AddressV1Schema,
  recipientName: z.string().min(1).max(255).endsWith('.base.eth').nullable().default(null),
  reconciliationBasis: z.literal('erc20_transfer_event').default('erc20_transfer_event'),
});

export const BaseMcpX402ActionReceiptV1Schema = BaseMcpActionReceiptCommonV1Schema.extend({
  approvalRequired: z.literal(true),
  actionType: z.literal('x402'),
  method: z.literal('GET'),
  url: z.string().url().startsWith('https://').max(2000),
  maxPayment: UsdcAmountSchema.refine((value) => Number(value) > 0, 'Payment cap must be positive'),
  paymentAsset: z.object({
    symbol: z.literal('USDC'),
    address: AddressV1Schema,
    decimals: z.literal(6),
  }),
  responseHash: HashV1Schema.nullable(),
  reconciliationBasis: z.literal('x402_endpoint_response'),
});

export const BaseMcpVirtualsActionReceiptV1Schema = BaseMcpActionReceiptCommonV1Schema.extend({
  approvalRequired: z.boolean(),
  actionType: z.literal('virtuals'),
  extensionProvider: z.literal('virtuals'),
  operation: z.literal('agent_create'),
  agentName: z.string().min(1).max(80),
  agentDescription: z.string().min(1).max(500),
  providerObjectId: z.string().min(1).max(200).nullable(),
  reconciliationBasis: z.literal('virtuals_provider_response'),
});

export const BaseMcpActionReceiptV1Schema = z.discriminatedUnion('actionType', [
  BaseMcpSendActionReceiptV1Schema,
  BaseMcpX402ActionReceiptV1Schema,
  BaseMcpVirtualsActionReceiptV1Schema,
]);

export const BaseMcpActionEnvelopeV1Schema = z.object({
  receipt: BaseMcpActionReceiptV1Schema,
  /** Ephemeral. It is returned to this browser but never persisted. */
  approvalUrl: z.string().url().startsWith('https://').nullable(),
  /** Bounded paid endpoint response returned once; never persisted. */
  resultPreview: z.string().max(2000).nullable().default(null),
});

// ---------------------------------------------------------------------------
// Connected Apps — the grants a wallet has handed to an assistant.
//
// The one thing this contract guarantees by SHAPE: there is no field a bearer
// token could be returned in. A grant is addressed by its opaque id, which is
// also what the revoke endpoint takes, so an owner never needs the credential
// in order to end it.
// ---------------------------------------------------------------------------

export const McpClientKindV1Schema = z.enum(['claude', 'chatgpt', 'hermes', 'other']);
export type McpClientKindV1 = z.infer<typeof McpClientKindV1Schema>;

export const McpHandoffGrantV1Schema = z
  .object({
    tokenId: z.string().min(1).max(100),
    grantKind: z.enum(['oauth', 'temporary_bearer']),
    /** Null is "nobody recorded one", never `other`. */
    clientKind: McpClientKindV1Schema.nullable(),
    clientName: z.string().min(1).max(120).nullable(),
    scopes: z.array(z.string().min(1).max(80)).max(16),
    walletAddress: z.string().max(42),
    /** Null when the issuance row is outside the audit window read. */
    issuedAt: z.string().datetime().nullable(),
    /** Null when the grant has never been used. Issuing is not using. */
    lastUsedAt: z.string().datetime().nullable(),
    useCount: z.number().int().min(0),
    revokedAt: z.string().datetime().nullable(),
    expiresAt: z.string().datetime().nullable(),
    status: z.enum(['current', 'expired', 'revoked', 'unknown']),
    historyComplete: z.boolean(),
  })
  .strict();
export type McpHandoffGrantV1 = z.infer<typeof McpHandoffGrantV1Schema>;

export const McpHandoffGrantsResponseV1Schema = z
  .object({
    schemaVersion: z.literal('mcp-handoff-grants/v1'),
    walletAddress: z.string().max(42),
    chainId: z.literal(8453),
    /** What this SERVER allows right now — not a per-grant scope. A handoff
     * token carries none, and the executable half can be switched off under a
     * token that already exists. */
    permissions: z
      .object({
        read: z.boolean(),
        executableHandoff: z.boolean(),
        scope: z.literal('server'),
      })
      .strict(),
    oauth: z
      .object({
        endpointUrl: z.string().url().startsWith('https://'),
        accessTokenTtlMinutes: z.number().int().positive(),
        grantTtlDays: z.number().int().positive(),
        refreshTokenRotation: z.literal(true),
      })
      .strict(),
    grants: z.array(McpHandoffGrantV1Schema).max(200),
  })
  .strict();
export type McpHandoffGrantsResponseV1 = z.infer<typeof McpHandoffGrantsResponseV1Schema>;

export const BaseMcpHandoffV1Schema = z.discriminatedUnion('target', [
  z.object({
    target: z.literal('routes'),
    path: z.string().min(1).max(120),
    reason: z.literal('routable_intent'),
    originalMessage: z.string().min(1).max(2000),
    provider: z.string().min(1).max(80).nullable().default(null),
  }),
  z.object({
    target: z.literal('provider'),
    provider: z.literal('avantis'),
    path: z.string().url().startsWith('https://www.avantisfi.com/trade?'),
    reason: z.literal('provider_ui_required'),
    originalMessage: z.string().min(1).max(2000),
    summary: z.string().min(1).max(500),
    risk: z.literal('liquidation'),
  }),
]);

export const BaseMcpConsoleResponseV1Schema = z.object({
  status: z.enum([
    'answered',
    'handoff',
    'action',
    'needs_input',
    'no_tools',
    'needs_reauth',
    'disabled',
    'failed',
  ]),
  reply: z.string().nullable(),
  trace: z.array(
    z.object({
      tool: z.string(),
      args: z.string(),
      ok: z.boolean(),
      result: z.string(),
      errorCode: z.string().nullable(),
    }),
  ),
  toolsAvailable: z.number(),
  truncated: z.boolean(),
  elapsedMs: z.number(),
  errorCode: z.string().nullable(),
  checkedAt: z.string(),
  handoff: BaseMcpHandoffV1Schema.nullable().default(null),
  action: BaseMcpActionEnvelopeV1Schema.nullable().default(null),
  /**
   * A link to the provider's own interface, built server-side from a code-owned
   * registry keyed by the plugin the ROUTER resolved.
   *
   * The url is validated here as well as at the source. The model can write
   * anything into `reply`; it can never write into this field, and a schema
   * that accepted a bare string would make that distinction invisible to
   * anyone reading the contract.
   */
  cta: z
    .object({
      label: z.string().min(1).max(80),
      url: z.string().url().max(300).startsWith('https://'),
    })
    .nullable()
    .default(null),
});

export const BaseMcpActionReconcileResponseV1Schema = BaseMcpActionEnvelopeV1Schema;
export const BaseMcpActionReceiptListResponseV1Schema = z.object({
  receipts: z.array(BaseMcpActionReceiptV1Schema).max(100),
});

export const DismissActionRequestSchema = z.object({
  actionId: z.string(),
});

export const DismissActionResponseSchema = z.object({
  success: z.boolean(),
});

export const DismissAllRecommendationsResponseSchema = z.object({
  success: z.boolean(),
  count: z.number().optional(),
});

export const DeleteRecommendationsResponseSchema = z.object({
  success: z.boolean(),
  count: z.number().optional(),
});

export const DeleteSingleActionResponseSchema = z.object({
  success: z.boolean(),
});

export const RegenerateRecommendationResponseSchema = z.object({
  success: z.boolean(),
  actionId: z.string().optional(),
  error: z.string().optional(),
});

// Memory
export const MemoryResponseSchema = z.object({
  memoryMd: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export const UpdateMemoryRequestSchema = z.object({
  memoryMd: z.string(),
});

export const UpdateMemoryResponseSchema = MemoryResponseSchema;

// Settings
export const SettingsResponseSchema = z.object({
  chosenModel: z.string().nullable(),
  protocolToggles: z.record(z.string(), z.boolean()).nullable(),
  updatedAt: z.string().nullable(),
});

export const UpdateSettingsRequestSchema = z.object({
  chosenModel: z.string().optional(),
  protocolToggles: z.record(z.string(), z.boolean()).optional(),
});

export const UpdateSettingsResponseSchema = SettingsResponseSchema;

// Protocols
export const ProtocolSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  status: z.string().optional(),
});

export const ProtocolsListResponseSchema = z.object({
  protocols: z.array(ProtocolSchema),
});

export const ToggleProtocolRequestSchema = z.object({
  protocolId: z.string(),
  enabled: z.boolean(),
});

export const ToggleProtocolResponseSchema = z.object({
  success: z.boolean(),
});

// Portfolio
export const PortfolioTokenSecuritySchema = z.object({
  provider: z.enum(['goplus', 'none']),
  status: z.enum(['ok', 'warning', 'high-risk', 'unknown', 'failed']),
  summary: z.string().optional(),
  riskLabels: z.array(z.string()).optional(),
  flags: z
    .object({
      isHoneypot: z.boolean().optional(),
      isMintable: z.boolean().optional(),
      isProxy: z.boolean().optional(),
      isOpenSource: z.boolean().optional(),
      hiddenOwner: z.boolean().optional(),
      canTakeBackOwnership: z.boolean().optional(),
      ownerCanChangeBalance: z.boolean().optional(),
      hasBlacklist: z.boolean().optional(),
      hasWhitelist: z.boolean().optional(),
      tradingCooldown: z.boolean().optional(),
      selfdestruct: z.boolean().optional(),
      externalCall: z.boolean().optional(),
      buyTax: z.string().optional(),
      sellTax: z.string().optional(),
      cannotSellAll: z.boolean().optional(),
      isInDex: z.boolean().optional(),
      holderCount: z.string().optional(),
    })
    .optional(),
});

export const PortfolioTokenSchema = z.object({
  symbol: z.string(),
  name: z.string().optional(),
  address: z.string(),
  balance: z.string(),
  balanceFormatted: z.string(),
  decimals: z.number().optional(),
  usdValue: z.string().optional(),
  usdPrice: z.string().optional(),
  priceConfidence: z.enum(['high', 'medium', 'low', 'unknown']).optional(),
  logoUrl: z.string().optional(),
  verified: z.boolean().optional(),
  possibleSpam: z.boolean().optional(),
  security: PortfolioTokenSecuritySchema.optional(),
  dataFreshness: z.enum(['live', 'cached']).optional(),
});

export const PortfolioProvidersSchema = z.object({
  rpc: z.enum(['connected', 'missing', 'failed']),
  tokenBalances: z.enum(['connected', 'missing', 'failed', 'stale', 'disabled', 'rate_limited']),
  tokenBalancesProvider: z.enum(['moralis', 'alchemy', 'none']).optional(),
  prices: z.enum(['connected', 'missing', 'failed', 'partial', 'disabled']),
  priceProvider: z.enum(['coingecko', 'moralis', 'none']).optional(),
  risk: z.enum(['connected', 'missing', 'failed', 'partial', 'disabled']),
  riskProvider: z.enum(['goplus', 'none']).optional(),
  approvals: z
    .enum([
      'connected',
      'missing',
      'failed',
      'partial',
      'disabled',
      'rate_limited',
      'budget_exhausted',
      'temporarily_unavailable',
    ])
    .optional(),
  approvalProvider: z.enum(['moralis', 'alchemy', 'none']).optional(),
});

export const ProviderCallSummaryItemSchema = z.object({
  provider: z.string(),
  status: z.string(),
  providerCalled: z.boolean(),
  budgetExhausted: z.boolean(),
  cacheAgeSeconds: z.number().optional(),
  requested: z.boolean().optional(),
  errorCode: z.string().optional(),
  note: z.string().optional(),
});

export const ApprovalScanSummarySchema = ProviderCallSummaryItemSchema.extend({
  requested: z.boolean(),
  totalApprovals: z.number(),
  tokenCount: z.number(),
  unlimitedCount: z.number(),
  riskySpenderCount: z.number(),
});

export const PortfolioResponseSchema = z.object({
  totalUsdValue: z.string().optional(),
  tokens: z.array(PortfolioTokenSchema),
  updatedAt: z.string(),
  providerStatus: z.string().optional(),
  dataFreshness: z.enum(['live', 'cached', 'stale', 'partial', 'failed']).optional(),
  cacheAgeSeconds: z.number().optional(),
  providerBudgetStatus: z
    .object({
      exhausted: z.boolean(),
      providers: z.array(z.string()),
    })
    .optional(),
  providerCallsMade: z.number().optional(),
  providers: PortfolioProvidersSchema.optional(),
  providerCallSummary: z.record(ProviderCallSummaryItemSchema).optional(),
  providerContext: z.record(z.any()).optional(),
  approvalScan: ApprovalScanSummarySchema.optional(),
  approvalSummary: z.record(z.any()).optional(),
  approvalFindings: z.array(z.record(z.any())).optional(),
  approvals: z.array(z.record(z.any())).optional(),
  analysis: z.record(z.any()).optional(),
});

export const TokenApprovalSchema = z.object({
  tokenAddress: z.string(),
  tokenSymbol: z.string(),
  tokenName: z.string().optional(),
  spenderAddress: z.string(),
  spenderLabel: z.string().optional(),
  allowanceRaw: z.string(),
  allowanceFormatted: z.string(),
  allowanceUsd: z.number().optional(),
  isUnlimited: z.boolean(),
  lastUpdatedAt: z.string().optional(),
  source: z.enum(['moralis', 'alchemy', 'basescan', 'none', 'unknown']),
});

export const ApprovalsResponseSchema = z.object({
  approvals: z.array(TokenApprovalSchema),
  status: z.enum([
    'connected',
    'missing',
    'failed',
    'partial',
    'disabled',
    'rate_limited',
    'budget_exhausted',
    'temporarily_unavailable',
  ]),
  provider: z.string(),
  tokenCount: z.number(),
  unlimitedCount: z.number(),
  riskySpenderCount: z.number(),
});

export const X402BuyerPayerSchema = z.object({
  status: z.enum(['ready', 'missing_config', 'unavailable', 'insufficient_usdc']),
  configured: z.boolean(),
  accountAddressPresent: z.boolean(),
  accountType: z.literal('cdp_evm_server_account'),
  walletName: z.string(),
  missingConfig: z.array(z.string()),
  errorCode: z.string().optional(),
  lastCheckedAt: z.string().optional(),
});

// T65.2A — the console's market rail.
//
// A snapshot the server READ, or a stated reason there is none. There is no
// third state: an absent price is absent on the screen, never a stale number
// presented as current. `observedAt` always describes the DATA, so a cached
// answer is visibly old rather than quietly fresh.
export const MarketSnapshotResponseV1Schema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('snapshot'),
      /** 'cached' means this exact snapshot was read earlier — check observedAt. */
      status: z.enum(['live', 'cached']),
      asset: z.literal('ETH'),
      vsCurrency: z.literal('usd'),
      /** A decimal string. Money never crosses this boundary as a float. */
      price: z.string().regex(/^\d+(\.\d+)?$/, 'Expected a decimal price'),
      changePercent1h: z
        .string()
        .regex(/^-?\d+(\.\d+)?$/)
        .nullable(),
      points: z.array(z.number().finite()).max(200),
      observedAt: z.string().datetime(),
      provider: z.literal('coingecko'),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('unavailable'),
      reason: z.enum([
        'not_configured',
        'provider_unavailable',
        'rate_limited',
        'provider_invalid_response',
      ]),
      /** The one sentence a surface shows. Fixed per reason, so an outage is
       * never phrased as a price. */
      detail: z.string().min(1).max(200),
    })
    .strict(),
]);

export const StatusResponseSchema = z.object({
  chainEnv: z.string(),
  chainId: z.number(),
  productMigration: z.object({
    routeIntelligenceV1: z.boolean(),
    legacyTerminal: z.boolean(),
    paidIntelligence: z.boolean(),
    earnRouteV1: z.boolean(),
    // T64: additive and optional so a client reading a pre-T64 server still
    // parses. Absent is treated as off by every surface that reads them.
    commerceRouteV1: z.boolean().optional(),
    commerceExecutionV1: z.boolean().optional(),
    // T65: same additive treatment. A pre-T65 server omits them, and absent
    // is off on every surface that reads them.
    nftRouteV1: z.boolean().optional(),
    nftExecutionV1: z.boolean().optional(),
    // T66: same additive treatment. A pre-T66 server omits them, and absent
    // is off on every surface that reads them.
    privateAiRouteV1: z.boolean().optional(),
    privateAiExecutionV1: z.boolean().optional(),
    // T67B.1: same additive treatment. There is no `aerodromeRouteV1` twin —
    // Aerodrome COMPARISON has no gate of its own; it rides on route
    // intelligence, because quoting it neither spends nor signs.
    aerodromeExecutionV1: z.boolean().optional(),
    // o1 comparison is part of route intelligence; execution is an
    // independent server-side gate, additive for older clients.
    o1ExecutionV1: z.boolean().optional(),
    hydrexExecutionV1: z.boolean().optional(),
    balancerExecutionV1: z.boolean().optional(),
    // T67C: same additive treatment.
    b20ControlV1: z.boolean().optional(),
    b20PublicContextV1: z.boolean().optional(),
    // Targeted measurement is deliberately absent, the same treatment
    // `tokenIdentityV1` gets: whether a named token is measured on demand is
    // decided server-side, and the ANSWER says what happened. A client with the
    // boolean would have nothing to decide with it.
    // T67C.2: same additive treatment.
    submissionRecoveryV1: z.boolean().optional(),
    publicProofV1: z.boolean().optional(),
    /** T67C.1: the frontend gets the boolean and NOTHING else — sample
     * thresholds stay server-side, because a client that could read them could
     * argue its way into a calibration it has not earned. */
    routeOutcomeFeedbackV1: z.boolean().optional(),
  }),
  rpc: z.object({
    status: z.enum(['connected', 'missing', 'failed']),
    provider: z.string(),
  }),
  tokenBalances: z.object({
    status: z.enum(['connected', 'missing', 'failed', 'stale', 'disabled']),
    provider: z.string(),
  }),
  prices: z.object({
    status: z.enum(['connected', 'missing', 'failed', 'partial', 'disabled']),
    provider: z.string(),
  }),
  risk: z.object({
    status: z.enum(['connected', 'missing', 'failed', 'partial', 'disabled']),
    provider: z.string(),
    authMode: z.enum(['public', 'app_token', 'public_fallback', 'disabled']).optional(),
    errorCode: z.string().max(120).optional(),
  }),
  approvals: z.object({
    status: z.enum([
      'connected',
      'missing',
      'failed',
      'partial',
      'disabled',
      'rate_limited',
      'budget_exhausted',
      'temporarily_unavailable',
      'auth_or_budget_issue',
    ]),
    provider: z.string(),
  }),
  cache: z
    .object({
      enabled: z.boolean(),
      balancesTtlSeconds: z.number(),
      pricesTtlSeconds: z.number(),
      securityTtlSeconds: z.number(),
      approvalsTtlSeconds: z.number(),
    })
    .optional(),
  budgets: z
    .record(
      z.string(),
      z.object({
        provider: z.string().optional(),
        status: z.enum([
          'ok',
          'rate-limited',
          'disabled',
          'rate_limited',
          'budget_exhausted',
          'auth_or_budget_issue',
        ]),
        callsLastMinute: z.number(),
        callsLastHour: z.number(),
        budgetExhausted: z.boolean().optional(),
        lastErrorCode: z.string().optional(),
        lastErrorAt: z.string().optional(),
        cooldownUntil: z.string().optional(),
      }),
    )
    .optional(),
  baseMcp: z.object({
    status: z.enum([
      'missing',
      'disabled',
      'connected',
      'needs_reauth',
      'unreachable',
      'degraded',
      'unsupported',
    ]),
    provider: z.literal('base-mcp'),
    configured: z.boolean(),
    enabled: z.boolean(),
    endpointHost: z.string().optional(),
    lastCheckedAt: z.string().optional(),
    errorCode: z.string().optional(),
    readiness: z
      .enum(['not_configured', 'configured', 'oauth_connected', 'tools_available', 'degraded'])
      .optional(),
    usable: z.boolean().optional(),
    capabilities: z
      .object({
        toolsCount: z.number().optional(),
        resourcesCount: z.number().optional(),
      })
      .optional(),
    toolsCount: z.number().optional(),
    readOnlyToolsCount: z.number().optional(),
    transactionToolsCount: z.number().optional(),
    forbiddenToolsCount: z.number().optional(),
    unknownToolsCount: z.number().optional(),
    lastToolProbeAt: z.string().optional(),
    auth: z
      .object({
        connected: z.boolean(),
        needsReauth: z.boolean(),
        userScoped: z.literal(true),
        expired: z.boolean().optional(),
        expiresAt: z.string().optional(),
        connectedAt: z.string().optional(),
      })
      .optional(),
    walletContext: z
      .object({
        tenantWallet: z.string(),
        baseAppWallet: z.string().nullable(),
        baseMcpWallet: z.string().nullable(),
        walletMatch: z.boolean().nullable(),
        executionProvider: z.enum(['baseapp_native', 'base_mcp', 'none']),
      })
      .optional(),
    protocolToolsStatus: z.enum(['available', 'unavailable']).optional(),
    walletToolsStatus: z
      .enum(['available', 'disabled_wallet_mismatch', 'unverified', 'unavailable'])
      .optional(),
  }),
  x402: z.object({
    status: z.enum([
      'configured',
      'connected',
      'missing',
      'unsupported_network_for_settlement',
      'facilitator_auth_required',
      'facilitator_auth_invalid',
      'facilitator_rate_limited',
      'facilitator_unreachable',
      'degraded',
    ]),
    configured: z.boolean().optional(),
    network: z.string().optional(),
    asset: z.string().optional(),
    facilitatorConfigured: z.boolean().optional(),
    payToConfigured: z.boolean().optional(),
    builderCodeConfigured: z.boolean().optional(),
    facilitatorAuthConfigured: z.boolean().optional(),
    authSource: z.enum(['bearer_token', 'cdp_api_key_pair']).optional(),
    settleReady: z.boolean().optional(),
    settleBlockedReason: z.string().optional(),
    probeStatus: z.string().optional(),
    middlewareMode: z.enum(['official', 'unavailable']).optional(),
    officialMiddlewareEnabled: z.boolean().optional(),
    smokeRoute: z.string().optional(),
    smokeRouteAvailable: z.boolean().optional(),
    builderCodeAttribution: z.enum(['attached', 'unavailable']).optional(),
    errorCode: z.string().optional(),
    lastCheckedAt: z.string().optional(),
    supportedKindsCount: z.number().optional(),
    supportedNetworks: z.array(z.string()).optional(),
    fuel: z
      .object({
        mode: z.enum(['buyer', 'seller_smoke', 'disabled']).optional(),
        buyerEnabled: z.boolean().optional(),
        activePermission: z.boolean().optional(),
        remainingUsdc: z.string().optional(),
        smokeResourceConfigured: z.boolean().optional(),
      })
      .optional(),
    buyerPayer: X402BuyerPayerSchema.optional(),
    missingConfig: z.array(z.string()).optional(),
    warnings: z.array(z.string()).optional(),
  }),
  // Current block and gas on the configured chain. Every value is nullable and
  // `reason` says why when it is null — a dash in the header must be able to
  // mean "the RPC did not answer", not just "nobody wired this".
  chain: z
    .object({
      blockNumber: z.string().nullable(),
      gasPriceWei: z.string().nullable(),
      gasPriceGwei: z.string().nullable(),
      observedAt: z.string().nullable(),
      // Measured samples only, oldest first. A gap here is a real gap.
      gasPoints: z.array(z.object({ at: z.string(), gwei: z.string() })),
      // Four causes used to arrive as `rpc_unreachable`, and they are four
      // different operator actions. Throttled is not down.
      reason: z.enum([
        'ok',
        'rpc_rate_limited',
        'rpc_http_error',
        'rpc_timeout',
        'rpc_unreachable',
        'rpc_invalid_response',
        'not_configured',
      ]),
    })
    .optional(),
  // T67X-A1: MIORAIL_PAID_INTELLIGENCE says an operator wants paid routes.
  // `readiness` says whether the facilitator can settle one. `blocked` means
  // paid features are off while every free capability keeps working.
  paidIntelligence: z
    .object({
      flagEnabled: z.boolean(),
      settleReady: z.boolean(),
      readiness: z.enum(['ready', 'blocked', 'disabled']),
      blockedReason: z.string().optional(),
      // WHICH operation costs money, and what it costs. A client must be able to
      // state the price before the user clicks, and it cannot know that from the
      // flags alone. Absent when nothing here is priced — so a surface with no
      // entry renders no price and offers no paid control, rather than guessing
      // a default and charging something else.
      pricedSurfaces: z
        .object({
          b20ExitProof: z.object({ priceUsdc: z.string() }).optional(),
          swapSimulation: z.object({ priceUsdc: z.string() }).optional(),
        })
        .optional(),
    })
    .optional(),
  autonomy: z
    .object({
      spendPermissionsPersistence: z.enum(['database']),
      databaseConfigured: z.boolean(),
      chainMode: z.string(),
      mainnetExecutionEnabled: z.boolean(),
      mainnetRequiresUserOptIn: z.boolean(),
    })
    .optional(),
  // T19.1: split into explicit flags. The UI may show "Confirm in Base Account"
  // ONLY when userConfirmedEnabled is true, and must never infer "Execute" from
  // a single generic flag. Legacy server-broadcast routes gate on
  // serverBroadcastEnabled / mainnetExecutionEnabled, never on userConfirmedEnabled.
  execution: z.object({
    mode: z.enum(['read-only', 'user-confirmed', 'server-execution']),
    // Base Account wallet_sendCalls flow is available.
    userConfirmedEnabled: z.boolean(),
    // Legacy /execute server-broadcast capability (testnet, or mainnet+flag).
    serverBroadcastEnabled: z.boolean(),
    // === MAINNET_EXECUTION_ENABLED === 'true'. Stays false in production.
    mainnetExecutionEnabled: z.boolean(),
    // Back-compat alias === serverBroadcastEnabled.
    broadcastEnabled: z.boolean().optional(),
    // T67X-B2: a usable ERC-8021 Builder Code resolves. When false on mainnet,
    // userConfirmedEnabled is forced false and `attributionBlockedReason` says
    // which way the configuration is wrong. Read-only capabilities are
    // unaffected — this never means the server is down.
    attributionReady: z.boolean().optional(),
    attributionBlockedReason: z
      .enum(['builder_code_missing', 'builder_code_invalid', 'builder_code_conflict'])
      .optional(),
    reason: z.string(),
  }),
});

// Workflows
export const WorkflowSchema = z.object({
  id: z.string(),
  instructions: z.string().nullable(),
  toolAllowlist: z.array(z.string()).nullable().optional(),
  intervalMs: z.number().nullable(),
  lastRun: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const WorkflowsListResponseSchema = z.object({
  workflows: z.array(WorkflowSchema),
});

export const CreateWorkflowRequestSchema = z.object({
  instructions: z.string().min(1),
  intervalMs: z.number().int().min(60000), // Min 1 minute
});

export const CreateWorkflowResponseSchema = z.object({
  success: z.boolean(),
  workflow: WorkflowSchema,
});

export const DeleteWorkflowRequestSchema = z.object({
  workflowId: z.string(),
});

export const DeleteWorkflowResponseSchema = z.object({
  success: z.boolean(),
});

// Autonomy
export const AutonomyStateResponseSchema = z.object({
  status: z.enum(['active', 'inactive', 'unconfigured', 'configured', 'revoked', 'expired']),
  source: z.enum(['database', 'memory', 'onchain', 'base-sepolia-contract', 'missing']),
  isStaleTestMemory: z.boolean().optional(),
  isExpiredMemory: z.boolean().optional(),
  chainId: z.number().optional(),
  contractAddress: z.string().nullable().optional(),
  sessionKey: z.object({
    status: z.enum(['configured', 'unconfigured', 'inactive', 'revoked', 'expired', 'active']),
    source: z
      .enum(['database', 'memory', 'onchain', 'base-sepolia-contract', 'missing'])
      .optional(),
    isStaleTestMemory: z.boolean().optional(),
    isExpiredMemory: z.boolean().optional(),
    dailyLimitUsdc: z.string().nullable(),
    spentTodayUsdc: z.string(),
    reservedTodayUsdc: z.string().optional(),
    maxPerActionUsdc: z.string().nullable(),
    ttlSeconds: z.number().nullable(),
    expiresAt: z.string().nullable(),
    whitelist: z.array(z.string()),
    scope: z.string(),
    killSwitch: z.boolean(),
    walletAddress: z.string().nullable().optional(),
    mainnetOptIn: z.boolean().optional(),
    executionReady: z.boolean().optional(),
    blockedReasons: z.array(z.string()).optional(),
    gatewayMode: z.enum(['unsigned-eip5792']).optional(),
    requiresUserApproval: z.boolean().optional(),
    owner: z.string().nullable().optional(),
    executor: z.string().nullable().optional(),
    token: z.string().nullable().optional(),
    validUntil: z.union([z.number(), z.string()]).nullable().optional(),
    txHashLastConfigured: z.string().nullable().optional(),
    txHashLastRevoked: z.string().nullable().optional(),
  }),
  autonomy: z.object({
    dailySpendLimit: z.string().nullable(),
    maxActionSpend: z.string().nullable(),
    whitelistedProtocolsCount: z.number(),
    mode: z.string(),
    source: z.enum(['database', 'memory', 'onchain', 'base-sepolia-contract', 'missing']),
    isStaleTestMemory: z.boolean().optional(),
    isExpiredMemory: z.boolean().optional(),
    executionReady: z.boolean().optional(),
    blockedReasons: z.array(z.string()).optional(),
    reservedTodayUsdc: z.string().optional(),
  }),
});

const UsdcPolicyAmountSchema = z
  .string()
  .regex(/^\d+(?:\.\d{1,6})?$/, 'Expected a positive USDC amount with at most 6 decimals');
const AutonomyAddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'Expected an Ethereum address');

export const ConfigureAutonomyRequestSchema = z
  .object({
    dailyLimitUsdc: UsdcPolicyAmountSchema,
    maxPerActionUsdc: UsdcPolicyAmountSchema,
    whitelist: z.array(AutonomyAddressSchema).min(1).max(100),
    scope: z.string().optional(),
    ttlSeconds: z
      .number()
      .int()
      .min(300)
      .max(30 * 24 * 60 * 60),
    walletAddress: AutonomyAddressSchema,
    mainnetOptIn: z.boolean().default(false),
    acknowledgeMainnetRisk: z.boolean().default(false),
  })
  .superRefine((value, context) => {
    const daily = Number(value.dailyLimitUsdc);
    const perAction = Number(value.maxPerActionUsdc);
    if (!Number.isFinite(daily) || daily <= 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dailyLimitUsdc'],
        message: 'Daily limit must be greater than zero',
      });
    }
    if (!Number.isFinite(perAction) || perAction <= 0 || perAction > daily) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxPerActionUsdc'],
        message: 'Per-action limit must be greater than zero and no higher than the daily limit',
      });
    }
  });

export const ConfigureAutonomyResponseSchema = z.object({
  success: z.boolean(),
  state: AutonomyStateResponseSchema,
  txHash: z.string().optional(),
});

export const KillAutonomyResponseSchema = z.object({
  success: z.boolean(),
  state: AutonomyStateResponseSchema,
  txHash: z.string().optional(),
});

export const TestnetConfigureAutonomyRequestSchema = z.object({
  dailyLimitUsdc: z.string(),
  maxPerActionUsdc: z.string(),
  whitelist: z.array(z.string()),
  ttlSeconds: z.number(),
  executor: z.string().optional(),
  token: z.string().optional(),
  owner: z.string().optional(),
});

export const TestnetRevokeAutonomyRequestSchema = z.object({
  executor: z.string().optional(),
  token: z.string().optional(),
  owner: z.string().optional(),
});

export const TestnetExecuteActionRequestSchema = z.object({
  target: z.string(),
  amountUsdc: z.string(),
  owner: z.string().optional(),
  token: z.string().optional(),
});

// x402 Ledger & Pricing
export const X402LedgerEntrySchema = z.object({
  id: z.string(),
  runId: z.string().optional(),
  actionId: z.string(),
  actionType: z.string(),
  direction: z.enum(['incoming_seller_smoke', 'outgoing_buyer_payment']).optional(),
  category: z.enum(['inference', 'premium_data', 'mcp_tool', 'execution', 'dev_smoke']).optional(),
  fuelPermissionId: z.string().optional(),
  fuelChargeId: z.string().optional(),
  fuelChargeTxHash: z.string().optional(),
  cost: z.string().nullable(),
  txHash: z.string().nullable(),
  network: z.string().optional(),
  asset: z.string().optional(),
  amount: z.string().optional(),
  payTo: z.string().optional(),
  status: z.enum(['settled', 'pending', 'failed']).optional(),
  settlementStatus: z.enum(['settled', 'pending', 'failed']).optional(),
  attribution: z.record(z.any()).optional().nullable(),
  createdAt: z.string(),
  settlement: z.string().optional(),
  details: z.record(z.any()).optional().nullable(),
});

export const X402LedgerResponseSchema = z.object({
  entries: z.array(X402LedgerEntrySchema),
  summary: z.object({
    totalSpentUsdc: z.string(),
    inferenceSpentUsdc: z.string(),
    toolsSpentUsdc: z.string(),
    premiumDataSpentUsdc: z.string().optional(),
    executionSpentUsdc: z.string().optional(),
    devSmokeSpentUsdc: z.string().optional(),
    failedBuyerAttemptsUsdc: z.string().optional(),
    unreimbursedBuyerAttemptsUsdc: z.string().optional(),
    sellerSmokeSpentUsdc: z.string().optional(),
    inferenceCallsCount: z.number(),
    toolsCallsCount: z.number(),
    premiumDataCallsCount: z.number().optional(),
    executionCallsCount: z.number().optional(),
    devSmokeCallsCount: z.number().optional(),
    failedBuyerAttemptsCount: z.number().optional(),
    unreimbursedBuyerAttemptsCount: z.number().optional(),
    pendingBuyerAttemptsCount: z.number().optional(),
    sellerSmokeDiagnosticsCount: z.number().optional(),
    sellerSmokeCallsCount: z.number().optional(),
    settlement: z.string().optional(),
    buyerFuelMode: z.string().optional(),
    x402: z.string().optional(),
    summaryScope: z.literal('latest_100_tenant_receipts').optional(),
    recordsConsidered: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional(),
  }),
});

export const X402PricingResponseSchema = z.object({
  pricing: z.array(
    z.object({
      actionType: z.string(),
      label: z.string(),
      priceUsdc: z.string(),
      description: z.string(),
    }),
  ),
});

export const X402FuelOwnerResponseSchema = z.object({
  status: z.enum(['ready', 'missing_config', 'unavailable']),
  configured: z.boolean(),
  accountAddressPresent: z.boolean(),
  subscriptionOwner: EthereumAddressSchema.optional(),
  walletName: z.string().optional(),
  chainId: z.literal(8453),
  asset: EthereumAddressSchema,
  testnet: z.literal(false),
  missingConfig: z.array(z.string()),
  errorCode: z.string().optional(),
});

export const X402FuelPermissionRequestSchema = z.object({
  id: z.string().min(1).max(256),
  subscriptionOwner: EthereumAddressSchema,
  subscriptionPayer: EthereumAddressSchema.optional(),
  recurringCharge: UsdcAmountSchema.optional(),
  periodInDays: z.number().int().min(1).max(366).optional(),
  limitUsdc: UsdcAmountSchema,
  ttlHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 366)
    .optional(),
});

const X402FuelActivePermissionSchema = z.object({
  id: z.string(),
  userId: z.string(),
  chainId: z.number(),
  asset: z.string().nullable().optional(),
  limitUsdc: z.string(),
  spentUsdc: z.string(),
  remainingUsdc: z.string(),
  expiresAt: z.string(),
  isActive: z.boolean(),
  whitelist: z.array(z.string()),
});

export const X402FuelPermissionResponseSchema = z.object({
  success: z.boolean(),
  status: z.literal('ready'),
  subscriptionId: z.string(),
  activePermission: X402FuelActivePermissionSchema,
});

export const X402FuelResponseSchema = z.object({
  status: z.enum([
    'ready',
    'missing_permission',
    'permission_inactive',
    'permission_expired',
    'limit_exhausted',
    'not_configured',
    'unavailable',
  ]),
  mode: z.literal('buyer'),
  activePermission: X402FuelActivePermissionSchema.nullable(),
  pendingReservations: z.array(
    z.object({
      id: z.string(),
      amountUsdc: z.string(),
      category: z.enum(['inference', 'premium_data', 'mcp_tool', 'execution', 'dev_smoke']),
      createdAt: z.string(),
    }),
  ),
  spendByCategory: z.object({
    inference: z.string(),
    premiumData: z.string(),
    mcpTool: z.string(),
    execution: z.string(),
    devSmoke: z.string(),
  }),
  recentReceipts: z.array(X402LedgerEntrySchema),
  buyerSmoke: z.object({
    configured: z.boolean(),
    urlHost: z.string().optional(),
  }),
  buyerPayer: X402BuyerPayerSchema,
  x402: z
    .object({
      settleReady: z.boolean().optional(),
      status: z.string().optional(),
      network: z.string().optional(),
    })
    .optional(),
});

// Simulate Action
export const SimulateActionResponseSchema = z.object({
  success: z.boolean(),
  allowed: z.boolean(),
  riskLevel: z.string(),
  reason: z.string().optional(),
  error: z.string().optional(),
  estimatedGas: z.string().optional(),
  expectedOutput: z.string().optional(),
  checks: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// T65.1 §2/§4 — the NFT purchase rail.
//
// The client never supplies calldata, a target, a value or a recipient. It
// sends a goal, then a Route Card hash, then the hash of the calls it
// reviewed. Everything that ends up in a wallet prompt is produced on the
// server from a pinned ABI.
// ---------------------------------------------------------------------------

export const NftCompareRequestV1Schema = z
  .object({
    message: z.string().trim().min(1).max(4_000),
    walletAddress: AddressV1Schema,
    requestId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'Invalid NFT compare request ID'),
  })
  .strict();

export const NftCompareResponseV1Schema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('compared'),
      routeRunId: z.string().min(1).max(200),
      routeCard: NftRouteCardV1Schema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal('unavailable'),
      routeRunId: z.string().min(1).max(200),
      /** A comparison that found nothing to buy still returns the card, so the
       * surface can name the token and the reason instead of showing nothing. */
      routeCard: NftRouteCardV1Schema,
      reason: z.string().min(1).max(60),
      detail: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('needs_clarification'),
      issues: z.array(z.string().min(1).max(120)),
    })
    .strict(),
  z.object({ outcome: z.literal('unsupported'), reason: z.string().min(1).max(200) }).strict(),
]);

/** Prepare names the reviewed card by HASH. A stale or unknown hash is
 * refused rather than silently re-priced at whatever is current. */
export const NftPrepareRequestV1Schema = z
  .object({
    routeRunId: z.string().min(1).max(200),
    routeCardHash: HashV1Schema,
    walletAddress: AddressV1Schema,
  })
  .strict();

export const NftPrepareResponseV1Schema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('prepared'),
      blueprintId: z.string().min(1).max(200),
      blueprint: NftPurchaseBlueprintV1Schema,
      simulation: SimulationStateV1Schema,
      /** The NFT Safety Kernel's own shape: EVERY violation, not the first.
       * A reviewer reading a refusal deserves the whole picture. */
      safety: z
        .object({ ok: z.boolean(), violations: z.array(z.string().min(1).max(60)) })
        .strict(),
      /** Why it cannot be signed, when it cannot. Null exactly when signable. */
      blockedReason: z.string().min(1).max(300).nullable(),
      /** False until every gate passes. A surface must not offer a wallet
       * prompt for a blueprint that is not signable. */
      signable: z.boolean(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('rejected'),
      reason: z.string().min(1).max(60),
      detail: z.string().min(1).max(200),
    })
    .strict(),
]);

/**
 * Approval names the blueprint by HASH, exactly as the swap and earn approvals
 * do — the same request the ONE shared submission hook already sends.
 *
 * This does not weaken "approval is of THESE calls": `blueprintHash` is
 * computed over `callsHash`, so a client that echoes the blueprint it reviewed
 * has, transitively, echoed the calls it reviewed. The server approves the
 * STORED calls hash; the client never gets to name one.
 */
export const NftApproveRequestV1Schema = z
  .object({
    routeRunId: z.string().min(1).max(200),
    blueprintHash: HashV1Schema,
    walletAddress: AddressV1Schema,
  })
  .strict();

/** The same discriminated shape swap and earn return, so the ONE wallet
 * submission implementation drives this family too rather than a second
 * sendCalls call site existing anywhere. Nothing NFT-specific rides along:
 * the Route Card, the blueprint and the proof are read from their own
 * endpoints, not smuggled through an EIP-5792 payload. */
export const NftApproveResponseV1Schema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('approved'),
      payload: z
        .object({
          /** Which family these calls came from. The wallet path is shared, so
           * the payload says what it is rather than the caller assuming. */
          goal: z.literal('nft'),
          blueprintId: z.string().min(1).max(200),
          blueprintHash: HashV1Schema,
          approvedCallsHash: HashV1Schema,
          chainId: z.literal('0x2105'),
          from: AddressV1Schema,
          /** Exactly one call: the Seaport fulfilment. */
          calls: z
            .array(
              z
                .object({
                  to: AddressV1Schema,
                  value: z.string().regex(/^0x[0-9a-f]+$/, 'Expected a hex quantity'),
                  data: HexDataV1Schema,
                })
                .strict(),
            )
            .length(1),
          atomicRequired: z.literal(true),
        })
        .strict(),
      lifecycle: NftPurchaseBlueprintStatusV1Schema,
    })
    .strict(),
  z.object({ outcome: z.literal('expired'), reason: z.string().min(1).max(500) }).strict(),
  z
    .object({
      outcome: z.literal('blocked'),
      reason: z.string().min(1).max(500),
      safety: z
        .object({ ok: z.boolean(), violations: z.array(z.string().min(1).max(60)) })
        .strict(),
    })
    .strict(),
]);

/**
 * What the CLIENT reports after calling the wallet. Recorded as a claim, not as
 * a fact about the chain — the proof reads that separately.
 *
 * Deliberately the swap request shape: a submission record is goal-agnostic, so
 * reusing it is what lets one hook record for three families. `receipts` is
 * accepted and NOT trusted; ownership is only ever established by the
 * server-side chain reads in reconciliation.
 */
export const NftSubmissionRequestV1Schema = SwapBlueprintSubmissionRequestV1Schema;

export const NftSubmissionResponseV1Schema = z
  .object({
    outcome: z.literal('recorded'),
    lifecycle: NftPurchaseBlueprintStatusV1Schema,
    /** Null exactly when nothing reached the chain — a wallet rejection has no
     * ownership question to answer, so no proof is opened for it. */
    proofId: z.string().min(1).max(200).nullable(),
    finalStatus: NftProofFinalStatusV1Schema.nullable(),
  })
  .strict();

export const NftProofResponseV1Schema = z
  .object({
    proofId: z.string().min(1).max(200),
    proof: NftPurchaseProofV1Schema,
    /** The fixed sentence for this final status. Never assembled per-request,
     * so a pending reconciliation cannot be phrased as a completed purchase. */
    copy: z.string().min(1).max(300),
    needsReconciliation: z.boolean(),
  })
  .strict();

// ---------------------------------------------------------------------------
// T66C/T66D — the Private AI rail.
//
// The transport shape is what enforces the privacy claim, so it is worth
// stating here rather than only in the engine:
//
//   * compare sends the PROMPT and receives back a NONCE. The server keeps
//     neither. The nonce is the only thing that can ever open the commitment,
//     and it exists in one place afterwards: the client.
//   * execute sends the prompt AGAIN, with the nonce. The server recomputes
//     the commitment and refuses if it differs — that is how a reviewed
//     request and an executed one are proved to be the same request without
//     the server storing the request.
//   * the proof that comes back carries no prompt and no completion. The
//     answer text is returned beside it, once, and is not part of it.
// ---------------------------------------------------------------------------

export const AiPromptMessageV1Schema = z
  .object({
    role: z.enum(['user', 'assistant']),
    text: z.string().min(1).max(500_000),
  })
  .strict();

export const AiCompareRequestV1Schema = z
  .object({
    /** The task, as the user wrote it. This IS the prompt. */
    messages: z.array(AiPromptMessageV1Schema).min(1).max(50),
    systemText: z.string().min(1).max(20_000).nullable().optional(),
    walletAddress: AddressV1Schema,
    requestId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'Invalid AI compare request ID'),
    privacyRequirement: z.enum(['private_only', 'prefer_private', 'any']).default('private_only'),
    /** The USD ceiling for this one call. Absent means the surface must ask
     * before anything runs — an unbounded inference request is never assumed. */
    maxSpendUsd: z
      .string()
      .regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$/)
      .nullable()
      .optional(),
    maxCompletionTokens: z.number().int().min(1).max(1_000_000).default(1_024),
    preferredModelId: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-zA-Z0-9._-]+$/)
      .nullable()
      .optional(),
    requiresToolCalling: z.boolean().optional(),
    requiresResponseSchema: z.boolean().optional(),
    requiresWebSearch: z.boolean().optional(),
  })
  .strict();

export const AiCompareResponseV1Schema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('compared'),
      routeRunId: z.string().min(1).max(200),
      routeCardId: z.string().min(1).max(200),
      routeCard: AiRouteCardV1Schema,
      /** The commitment this run is pinned to. Safe to show and to store — it
       * is the card's identity for the request, and it cannot be opened
       * without the nonce below. The Review screen displays it so a user can
       * see the request is fixed before anything is sent. */
      promptCommitment: HashV1Schema,
      /** Returned ONCE. The server does not store it, and without it the
       * commitment on the card cannot be opened by anyone — including us. */
      promptNonce: z.string().min(32).max(200),
      /** Whether this server would actually run the request. Comparison being
       * on does not imply execution is. */
      executionEnabled: z.boolean(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('unavailable'),
      routeRunId: z.string().min(1).max(200),
      /** A comparison that selected nothing still returns the card, so the
       * surface can show which models were refused and why. */
      routeCard: AiRouteCardV1Schema.nullable(),
      reason: z.string().min(1).max(60),
      detail: z.string().min(1).max(300),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('needs_clarification'),
      issues: z.array(z.string().min(1).max(200)),
    })
    .strict(),
  z.object({ outcome: z.literal('unsupported'), reason: z.string().min(1).max(300) }).strict(),
]);

export const AiExecuteRequestV1Schema = z
  .object({
    routeRunId: z.string().min(1).max(200),
    /** The reviewed card, named by hash. A stale or unknown hash is refused
     * rather than silently re-run against whatever is current. */
    routeCardHash: HashV1Schema,
    walletAddress: AddressV1Schema,
    /** Re-submitted so the server can prove this is the reviewed request
     * without ever having stored it. */
    messages: z.array(AiPromptMessageV1Schema).min(1).max(50),
    systemText: z.string().min(1).max(20_000).nullable().optional(),
    promptNonce: z.string().min(32).max(200),
    temperature: z.number().min(0).max(2).nullable().optional(),
    responseSchema: z.record(z.unknown()).nullable().optional(),
  })
  .strict();

export const AiExecuteResponseV1Schema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('completed'),
      proofId: z.string().min(1).max(200),
      proof: AiInferenceProofV1Schema,
      /** The answer. Returned to the caller and stored by nothing. */
      text: z.string().max(1_000_000),
      copy: z.string().min(1).max(300),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('refused'),
      /** A model that considered the request and declined leaves a proof. */
      proofId: z.string().min(1).max(200),
      proof: AiInferenceProofV1Schema,
      copy: z.string().min(1).max(300),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('blocked'),
      reason: z.string().min(1).max(60),
      detail: z.string().min(1).max(300),
    })
    .strict(),
]);

export const AiProofResponseV1Schema = z
  .object({
    proofId: z.string().min(1).max(200),
    proof: AiInferenceProofV1Schema,
    /** The fixed sentence for this final status. Never assembled per-request,
     * so a truncated answer cannot be phrased as a completed one. */
    copy: z.string().min(1).max(300),
  })
  .strict();

// ---------------------------------------------------------------------------
// T67C — B20 Control Card. Read-only, and the schemas say so: no request field
// carries calldata, a recipient, a value or an amount, and no response field
// carries a transaction, a call or a payload to sign. There is nothing here to
// approve, because there is nothing here that moves.
// ---------------------------------------------------------------------------

export const B20InspectRequestV1Schema = z
  .object({
    /** Base mainnet only. A literal, so another chain is a 400, not a silent
     * read of the wrong network. */
    chainId: z.literal(8453),
    tokenAddress: AddressV1Schema,
  })
  .strict();
export type B20InspectRequestV1 = z.infer<typeof B20InspectRequestV1Schema>;

const B20FieldV1Schema = z
  .object({
    key: z.string().min(1).max(60),
    label: z.string().min(1).max(120),
    // Mirrors B20FieldStatusV1Schema in @mioagent/b20-control, which is the
    // source of truth. A status missing here is not emitted at all — the
    // response fails validation rather than shipping an undeclared shape.
    status: z.enum([
      'exact_chain_read',
      'unavailable',
      'not_enumerable',
      'unsupported_by_variant',
      'planned_not_active',
      'conflicting_evidence',
    ]),
    value: z.string().max(500).nullable(),
    reason: z.string().max(300).nullable(),
    evidenceHash: z
      .string()
      .regex(/^0x[0-9a-f]{64}$/)
      .nullable(),
  })
  .strict();

const B20StatementV1Schema = z
  .object({
    key: z.string().min(1).max(60),
    statement: z.string().min(1).max(300),
    observedState: z.enum(['constrained', 'unconstrained', 'unknown']),
    evidenceHash: z
      .string()
      .regex(/^0x[0-9a-f]{64}$/)
      .nullable(),
  })
  .strict();

const B20EvidenceV1Schema = z
  .object({
    schemaVersion: z.literal('b20-control-evidence/v1'),
    evidenceHash: z.string().regex(/^0x[0-9a-f]{64}$/),
    chainId: z.literal(8453),
    tokenAddress: AddressV1Schema,
    target: AddressV1Schema,
    blockNumber: z.string().regex(/^(0|[1-9][0-9]*)$/),
    blockHash: z.string().regex(/^0x[0-9a-f]{64}$/),
    methodSignature: z.string().min(3).max(120),
    selector: z.string().regex(/^0x[0-9a-f]{8}$/),
    rawResponseHash: z.string().regex(/^0x[0-9a-f]{64}$/),
    decodedValue: z.string().max(500).nullable(),
    revertSelector: z
      .string()
      .regex(/^0x[0-9a-f]{8}$/)
      .nullable(),
    observedAt: z.string(),
    verification: z.literal('exact_chain_read'),
    sourceVersion: z.string().min(1).max(120),
  })
  .strict();

export const B20ControlCardResponseV1Schema = z
  .object({
    schemaVersion: z.literal('b20-control-card/v1'),
    cardHash: z.string().regex(/^0x[0-9a-f]{64}$/),
    snapshotId: z.string().min(1).max(200),
    snapshotHash: z.string().regex(/^0x[0-9a-f]{64}$/),
    identityHash: z.string().regex(/^0x[0-9a-f]{64}$/),
    chainId: z.literal(8453),
    tokenAddress: AddressV1Schema,
    displayName: z.string().max(200).nullable(),
    displaySymbol: z.string().max(60).nullable(),
    variant: z.enum(['asset', 'stablecoin']).nullable(),
    detectionOutcome: z.enum([
      'b20',
      'not_b20',
      'b20_uninitialised',
      'unavailable_at_block',
      'rpc_failure',
      'invalid_address',
      'unsupported_chain',
    ]),
    blockNumber: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .nullable(),
    blockHash: z
      .string()
      .regex(/^0x[0-9a-f]{64}$/)
      .nullable(),
    observedAt: z.string(),
    fields: z.array(B20FieldV1Schema).max(64),
    statements: z.array(B20StatementV1Schema).max(32),
    unavailable: z.array(z.string().max(200)).max(32),
    boundaries: z.array(z.string().max(200)).max(16),
  })
  .strict();
export type B20ControlCardResponseV1 = z.infer<typeof B20ControlCardResponseV1Schema>;

// T67F — B20 Control Watch: what moved between the last reading and this one.
//
// Every change names both evidence hashes and both blocks, so the claim is
// checkable at each end. `gaps` is deliberately separate from `changes`: a
// field that stopped being readable says something about Miorail's view, not
// about the token, and reporting it as a change would attach an evidence hash
// to a fabrication.
export const B20ControlChangeV1Schema = z
  .object({
    kind: z.string().min(1).max(60),
    fieldKey: z.string().min(1).max(60),
    label: z.string().min(1).max(120),
    severity: z.enum(['acute', 'material', 'informational']),
    before: z.string().max(500),
    after: z.string().max(500),
    detail: z.string().min(1).max(600),
    evidenceBefore: HashV1Schema.nullable(),
    evidenceAfter: HashV1Schema.nullable(),
  })
  .strict();

export const B20ObservationGapV1Schema = z
  .object({
    fieldKey: z.string().min(1).max(60),
    label: z.string().min(1).max(120),
    direction: z.enum(['became_unreadable', 'became_readable']),
    reason: z.string().max(300).nullable(),
  })
  .strict();

export const B20ControlWatchV1Schema = z
  .object({
    tokenAddress: AddressV1Schema,
    fromBlock: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .nullable(),
    toBlock: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .nullable(),
    fromObservedAt: z.string().min(1).max(60).nullable(),
    toObservedAt: z.string().min(1).max(60),
    changes: z.array(B20ControlChangeV1Schema).max(64),
    gaps: z.array(B20ObservationGapV1Schema).max(64),
    status: z.enum(['compared', 'first_observation', 'not_comparable']),
    notComparableReason: z.string().max(300).nullable(),
  })
  .strict();

// T67F — the portfolio sweep. The client sends the tokens it holds; the server
// never guesses a holdings list, because a wrong one would produce a watch page
// about somebody else's position.
export const B20WatchRequestV1Schema = z
  .object({
    chainId: z.literal(8453),
    // Bounded on the wire, not only in the handler: each entry is an on-chain
    // read against a metered endpoint.
    tokens: z.array(AddressV1Schema).min(1).max(25),
  })
  .strict();

export const B20WatchedTokenV1Schema = z
  .object({
    tokenAddress: AddressV1Schema,
    displayName: z.string().max(200).nullable(),
    displaySymbol: z.string().max(60).nullable(),
    /** `not_b20` is an ordinary, expected answer — most tokens are not B20. */
    outcome: z.enum(['watched', 'not_b20', 'unreadable']),
    /** Present only when the token was actually compared. */
    watch: B20ControlWatchV1Schema.optional(),
    /** The exit-relevant controls, read at `controls.blockNumber`. Present
     * whenever a snapshot exists — this is what a holder's card is about. */
    controls: z
      .object({
        factoryConfirmed: z.boolean(),
        transfersPaused: z.boolean(),
        transferPolicyActive: z.boolean(),
        controlsFullyRead: z.boolean(),
        supplyCapped: z.boolean(),
        blockNumber: z
          .string()
          .regex(/^(0|[1-9][0-9]*)$/)
          .nullable(),
      })
      .strict()
      .optional(),
    /** The holder's balance, read FROM THE TOKEN at the control block — not
     * from a balance provider, because none of them index B20. Null means the
     * read failed, never that the balance is zero. */
    balanceAtomic: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .nullable()
      .optional(),
    decimals: z.number().int().min(0).max(36).nullable().optional(),
    /** Why nothing was compared. Never a claim about the token. */
    reason: z.string().max(300).nullable(),
  })
  .strict();

export const B20WatchResponseV1Schema = z
  .object({
    tokens: z.array(B20WatchedTokenV1Schema).max(25),
    /** Tokens the request named that were not reached before the budget ran
     * out. Named, so the page never implies it checked everything. */
    notChecked: z.array(AddressV1Schema).max(25),
    checkedAt: z.string().min(1).max(60),
  })
  .strict();

// T68B — the watchlist a background sweep reads.
//
// The wire carries no sweep schedule, no interval and no "next run" field. When
// Miorail will next read a token is an operator's concern; what a holder needs
// is when it LAST read one, which is `lastSweptAt` and is a fact rather than a
// promise.
/**
 * Phase 8 — what is owed on one address, and when.
 *
 * Null when the sweep has not reconciled this address yet. That is not "never
 * checked": it is "no promise has been made", and a surface that printed an
 * interval there would be advertising a schedule nothing is keeping.
 *
 * `lastCompletedAt` is separate from `lastCheckedAt` on purpose. A failed pass
 * moves the clock so a broken address cannot monopolise the queue, and moves
 * nothing else — freshness is never read out of an outage.
 */
export const B20WatchScheduleV1Schema = z
  .object({
    intervalSeconds: z.number().int().min(900).max(86_400),
    nextDueAt: z.string().datetime(),
    lastCheckedAt: z.string().datetime().nullable(),
    lastCompletedAt: z.string().datetime().nullable(),
    lastOutcome: z.enum(['measured', 'measurement_failed', 'unreadable']).nullable(),
    checks: z.number().int().min(0),
    completedChecks: z.number().int().min(0),
  })
  .strict();

/** One recorded transition on a watched address. Kinds and facts exactly as
 * the signal feed carries them, so the two surfaces cannot describe one event
 * in two vocabularies. */
export const B20WatchChangeV1Schema = z
  .object({
    signalId: z.string().min(1).max(40),
    kind: z.string().min(1).max(60),
    occurredAt: z.string().datetime(),
    recordedAt: z.string().datetime(),
    facts: z.record(z.unknown()),
  })
  .strict();

export const B20WatchlistEntryV1Schema = z
  .object({
    tokenAddress: AddressV1Schema,
    addedAt: z.string().min(1).max(60),
    /** When a sweep last reached this token, background or interactive. Null
     * means never read — which is not the same as unchanged, and the two must
     * not render alike. */
    lastSweptAt: z.string().min(1).max(60).nullable(),
    lastOutcome: z.enum(['read', 'not_b20', 'unreadable']).nullable(),
    schedule: B20WatchScheduleV1Schema.nullable(),
    /** Newest first. What CHANGED, never the current state repeated. */
    changes: z.array(B20WatchChangeV1Schema).max(10),
  })
  .strict();

/**
 * The promise, and the arithmetic behind it.
 *
 * Published rather than kept internal because the interval on screen is a
 * commitment: a reader is entitled to see what it is derived from, and an
 * operator is entitled to see which budget ran out first.
 */
export const B20WatchSlaV1Schema = z
  .object({
    /** Distinct addresses across every account. Two people watching one token
     * is one check — that is what makes the interval affordable. */
    distinctAddresses: z.number().int().min(0),
    /** What a surface may say. Never faster than `achievableIntervalSeconds`. */
    advertisedIntervalSeconds: z.number().int().min(900).max(86_400),
    /** What the budget supports, to the second. Arithmetic, not a promise. */
    achievableIntervalSeconds: z.number().int().min(0),
    limitedBy: z.enum(['rpc', 'router', 'tier_floor', 'nothing_watched']),
    utilisation: z.number().min(0).max(1),
    /** True when the list has outgrown the slowest interval we publish. The
     * promise is then not keepable and the surface says so. */
    beyondSlowestTier: z.boolean(),
    /** False until the sweep has reconciled the schedule at least once. */
    scheduleActive: z.boolean(),
  })
  .strict();

export const B20WatchlistResponseV1Schema = z
  .object({
    tokens: z.array(B20WatchlistEntryV1Schema).max(25),
    /** How many more this account may add, so a surface can say so before a
     * user types an address and is refused. */
    remaining: z.number().int().min(0).max(25),
    sla: B20WatchSlaV1Schema,
  })
  .strict();

/** The presets a surface may offer. `official_assets` is the corpus the server
 * already holds; a wallet's own positions are suggested by the client from
 * balances it has already read, never enrolled by the server. */
export const B20WatchPresetRequestV1Schema = z
  .object({ preset: z.literal('official_assets') })
  .strict();

export const B20WatchlistAddRequestV1Schema = z
  .object({
    chainId: z.literal(8453),
    tokenAddress: AddressV1Schema,
  })
  .strict();

// T68C — the exit check. "Can I get back out, and at what cost."
//
// The request carries a PROFILE, not a route: a position size and two
// tolerances. There is deliberately no field for a router, a pool, a path or a
// recipient — this is a read, and the server decides what to ask by quoting
// every allowed candidate rather than being told which one to trust.
export const B20ExitCheckRequestV1Schema = z
  .object({
    chainId: z.literal(8453),
    tokenAddress: AddressV1Schema,
    /** Atomic units of USDC the user would put in. Bounded on the wire: each
     * check is a dozen-odd metered router calls. */
    positionAtomic: z.string().regex(/^[1-9][0-9]{0,17}$/),
    /** Round-trip cost the user will accept, in basis points. */
    maxRoundTripBps: z.number().int().min(1).max(10_000),
    /** Slippage tolerance the exit capacity is measured against. */
    maxSlippageBps: z.number().int().min(1).max(10_000),
  })
  .strict();

export const B20ExitCheckResponseV1Schema = z
  .object({
    tokenAddress: AddressV1Schema,
    /**
     * T68D — four states, and this endpoint can only ever produce three of
     * them.
     *
     * `qualified` is absent by construction: the exit check quotes, and a quote
     * taken before the entry moves the pool may soundly REJECT but can never
     * certify. Only `/b20/opportunity/simulate` returns `qualified`, and only
     * after both legs executed sequentially against one state.
     *
     * `unmeasured` is not a hedge. Once a route search has been throttled, a
     * missing route says nothing about the token — this code once reported AERO,
     * one of the deepest pools on Base, as impossible to sell out of.
     */
    status: z.enum(['provisional', 'rejected', 'unmeasured']),
    /** Why nothing could be concluded. Null unless `status` is `unmeasured`. */
    unmeasuredReason: z
      .enum([
        'endpoint_degraded',
        'simulation_unavailable',
        'insufficient_probe_balance',
        'simulation_undecodable',
        'controls_unread',
        'venue_not_indexed',
        'quote_asset_mismatch',
      ])
      .nullable()
      .optional(),
    /** How complete the route search was. A route that was PROVEN to work is a
     * different fact from a search that saw every candidate. */
    coverage: z.enum(['complete', 'partial']).optional(),
    viableRouteConfirmed: z.boolean().optional(),
    bestRouteConfirmed: z.boolean().optional(),
    /** Present on a rejection. One of the fixed reasons — never free text, so a
     * surface cannot be handed a sentence it did not write. */
    reason: z
      .enum([
        'not_b20',
        'controls_unreadable',
        'transfers_paused',
        'transfer_policy_may_block',
        'no_entry_route',
        'no_exit_route',
        'round_trip_above_tolerance',
        'exit_capacity_below_position',
      ])
      .nullable(),
    /** `quoted_pre_entry` means the exit was priced against the pool BEFORE the
     * entry moved it, so the round trip is a bound rather than a result. Sent
     * so the screen can say so rather than the server deciding it does not
     * matter. */
    measurement: z.enum(['simulated', 'quoted_pre_entry']).nullable(),
    optimistic: z.boolean(),
    roundTripCostBps: z.number().int().min(0).max(100_000).nullable(),
    /** Atomic units of the TOKEN, not of USDC: capacity is measured in what is
     * being sold. */
    exitCapacityAtomic: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .nullable(),
    firstFailingAtomic: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .nullable(),
    probeCount: z.number().int().min(0).max(16),
    /** False when the ladder measured a single point. A pass on one probe is
     * not a depth finding and must not be shown as one. */
    capacityInformative: z.boolean(),
    /** What every impact figure is relative to. Impact is measured against the
     * smallest probe that priced, never against a mid price. */
    referenceSizeAtomic: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .nullable(),
    /** True when a read failed for a reason that is not "no such pool". An
     * all-empty result from a failing endpoint is not "no liquidity". */
    endpointDegraded: z.boolean(),
    /** The block the controls were read at, so the two halves of this answer
     * can be dated independently. */
    controlsBlockNumber: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .nullable(),
    /** The exact buy quote behind the displayed unit price. Additive and
     * nullable so older clients keep parsing older deployments. */
    entryInputAtomic: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .nullable()
      .optional(),
    entryOutputAtomic: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .nullable()
      .optional(),
    quoteAsset: AddressV1Schema.nullable().optional(),
    provider: z.enum(['aerodrome', 'uniswap_v4']).nullable().optional(),
    sourceKey: z.string().min(1).max(200).nullable().optional(),
    checkedAt: z.string().min(1).max(60),
  })
  .strict();

// T68D §4/§5 — the only endpoint that can certify.
//
// The request carries a PROFILE and a token. There is deliberately no field for
// calls, calldata, a router, a route, a recipient or a deadline: the server
// builds every byte from the pinned Aerodrome surface and the authenticated
// wallet, so a client cannot widen what gets simulated.
export const B20OpportunitySimulateRequestV1Schema = z
  .object({
    chainId: z.literal(8453),
    tokenAddress: AddressV1Schema,
    positionAtomic: z.string().regex(/^[1-9][0-9]{0,17}$/),
    maxRoundTripBps: z.number().int().min(1).max(10_000),
    maxExitSlippageBps: z.number().int().min(1).max(10_000),
  })
  .strict();

export const B20OpportunitySimulateResponseV1Schema = z
  .object({
    tokenAddress: AddressV1Schema,
    viability: z.enum(['qualified', 'rejected', 'provisional', 'unmeasured']),
    rejectionReason: z
      .enum([
        'not_b20',
        'controls_unreadable',
        'transfers_paused',
        'transfer_policy_may_block',
        'no_entry_route',
        'no_exit_route',
        'round_trip_above_tolerance',
        'exit_capacity_below_position',
        'simulation_reverted',
        'simulated_round_trip_above_tolerance',
      ])
      .nullable(),
    unmeasuredReason: z
      .enum([
        'endpoint_degraded',
        'simulation_unavailable',
        'insufficient_probe_balance',
        'simulation_undecodable',
        'controls_unread',
      ])
      .nullable(),
    coverage: z.enum(['complete', 'partial']),
    viableRouteConfirmed: z.boolean(),
    bestRouteConfirmed: z.boolean(),
    /** Present only on `qualified`. The handle a preparation must carry, and
     * the ONLY thing that opens the entry route for this token. */
    clearanceId: z.string().min(1).max(200).nullable(),
    expiresAt: z.string().min(1).max(60).nullable(),
    /** What the simulation OBSERVED, not what a quote predicted. */
    simulatedRoundTripBps: z.number().int().min(0).max(100_000).nullable(),
    simulatedReturnedAtomic: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .nullable(),
    simulatedAcquiredAtomic: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .nullable(),
    simulationBlockNumber: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .nullable(),
    controlsBlockNumber: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .nullable(),
    checkedAt: z.string().min(1).max(60),
  })
  .strict();

// T68E — consuming a clearance.
//
// The request identifies a clearance and nothing executable. There is
// deliberately no field for calldata, a token, a route, a recipient, a spender,
// an amount, a slippage or a factory: every one of those is recovered from the
// stored clearance and rebuilt server-side, so a client cannot widen what gets
// prepared by editing a request body.
/**
 * T68F-A §8 — the Review projection.
 *
 * What a Review screen may show, and deliberately nothing more. There is no
 * calldata, no raw simulation body, no credential, no RPC endpoint and no
 * session identifier in this shape: the executable bytes stay server-side until
 * a submission path exists to use them.
 */
export const B20EntryReviewV1Schema = z
  .object({
    planId: z.string().min(1).max(200),
    executionFamily: z.literal('b20_opportunity_entry'),
    spend: z
      .object({
        asset: AddressV1Schema,
        amountAtomic: z.string().regex(/^[1-9][0-9]{0,17}$/),
        decimals: z.literal(6),
      })
      .strict(),
    receive: z
      .object({
        tokenAddress: AddressV1Schema,
        tokenName: z.string().max(120).nullable(),
        tokenSymbol: z.string().max(60).nullable(),
        tokenDecimals: z.number().int().min(0).max(36).nullable(),
        expectedOutputAtomic: z.string().regex(/^[1-9][0-9]*$/),
        minimumOutputAtomic: z.string().regex(/^[1-9][0-9]*$/),
      })
      .strict(),
    provider: z
      .object({
        providerId: z.string().min(1).max(60),
        providerName: z.string().min(1).max(60),
        sourceKey: z.string().min(1).max(300),
      })
      .strict(),
    entryRouteHash: z.string().regex(/^0x[0-9a-f]{64}$/),
    /** Either the exact approval this plan asks for, or the standing allowance
     * it found sufficient. A Review showing neither would leave the user unable
     * to tell whether they are about to grant one. */
    approval: z
      .object({
        required: z.boolean(),
        amountAtomic: z
          .string()
          .regex(/^[1-9][0-9]*$/)
          .nullable(),
      })
      .strict(),
    clearanceId: z.string().min(1).max(200),
    clearanceCreatedAt: z.string().min(1).max(60),
    clearanceExpiresAt: z.string().min(1).max(60),
    certificationBlockNumber: z.string().regex(/^(0|[1-9][0-9]*)$/),
    prepareControlBlockNumber: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .nullable(),
    prepareSimulationBlockNumber: z.string().regex(/^(0|[1-9][0-9]*)$/),
    certificationRoundTripBps: z.number().int().min(0).max(100_000),
    coverage: z.enum(['complete', 'partial']),
    viableRouteConfirmed: z.boolean(),
    bestRouteConfirmed: z.boolean(),
    /** The sentence that stops a user believing this round-trips their money. */
    exitNotice: z.string().min(1).max(200),
    lifecycle: z.enum(['prepared', 'awaiting_wallet_approval', 'submitted', 'terminal']),
    expiresAt: z.string().min(1).max(60),
    /** True only when the whole submission path exists in this surface. Never
     * inferred from the plan holding unsigned calls. */
    executionAvailable: z.boolean(),
    executionUnavailableReason: z.literal('submission_not_wired').nullable(),
  })
  .strict();

/** T68F-B §13 — the one state both surfaces switch on. Derived on the server
 * from the stored plan and the stored attempt, so the interface and the miniapp
 * cannot disagree about whether a second submit button is allowed. */
export const B20EntryUiStateV1Schema = z.enum([
  'preparing',
  'review',
  'expired',
  'awaiting_wallet_approval',
  'user_rejected',
  'submitted',
  'reconciling',
  'entry_succeeded',
  'entry_reverted',
  'submitted_unknown',
  'reconciliation_required',
]);

/** What actually happened on chain, once checked against the plan. */
export const B20EntryOutcomeV1Schema = z
  .object({
    state: B20EntryUiStateV1Schema,
    terminalOutcome: z
      .enum([
        'entry_succeeded',
        'entry_reverted',
        'submitted_unknown',
        'reconciliation_required',
        'user_rejected',
        'cancelled_before_submission',
      ])
      .nullable(),
    attemptId: z.string().min(1).max(200).nullable(),
    /** The wallet's own batch handle. Present once the wallet returned one. */
    batchId: z.string().min(1).max(200).nullable(),
    submittedAt: z.string().min(1).max(60).nullable(),
    /** A short code, never a provider message: those carry endpoints, and
     * endpoints carry keys. */
    errorCode: z.string().min(1).max(80).nullable(),
    actualSpentAtomic: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .nullable(),
    actualReceivedAtomic: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .nullable(),
    confirmedBlockNumber: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .nullable(),
    transactionHashes: z.array(z.string().regex(/^0x[0-9a-f]{64}$/)).max(16),
    reconciliationEvidenceHash: z
      .string()
      .regex(/^0x[0-9a-f]{64}$/)
      .nullable(),
    /** Whether this state may show a button that opens a wallet, and whether
     * it may offer a status refresh. Server-decided so neither surface has to
     * re-derive it. */
    canSubmit: z.boolean(),
    canRefresh: z.boolean(),
  })
  .strict();

/** The wallet request, in the shape the existing Base Account integration
 * already speaks. The ONLY place executable bytes leave the server, and they
 * are always the stored ones. */
export const B20EntryWalletPayloadV1Schema = z
  .object({
    planId: z.string().min(1).max(200),
    blueprintHash: HashV1Schema,
    approvedCallsHash: HashV1Schema,
    callsHash: HashV1Schema,
    chainId: z.literal('0x2105'),
    from: AddressV1Schema,
    calls: z
      .array(
        z
          .object({
            to: AddressV1Schema,
            value: z.string().regex(/^0x[0-9a-f]+$/, 'Expected a hex quantity'),
            data: HexDataV1Schema,
          })
          .strict(),
      )
      .min(1)
      .max(2),
    /** Approval and swap land together or not at all: an approval that
     * executed without its swap is a standing allowance nobody asked for. */
    atomicRequired: z.literal(true),
  })
  .strict();

/** Public-safe handle for the canonical RouteProofV1. The proof's executable
 * calls stay server-side; this projection is enough to inspect its lineage and
 * reconciliation state. */
export const B20EntryRouteProofSummaryV1Schema = z
  .object({
    proofId: z.string().min(1).max(200),
    proofHash: HashV1Schema,
    finalStatus: z.enum([
      'pending',
      'completed',
      'partial_failure',
      'failed',
      'cancelled',
      'reconciliation_required',
    ]),
    reconciliationState: z.enum([
      'pending',
      'matched',
      'deviated',
      'partial',
      'failed',
      'manual_review',
    ]),
    approvedCallsHash: HashV1Schema,
    transactionHashes: z.array(HashV1Schema).max(16),
    updatedAt: z.string().datetime(),
  })
  .strict();

/** POST begin-submission. Carries NO calls, no calldata, no router, no
 * recipient and no amount — the server recovers all of that by plan id. */
export const B20EntryBeginSubmissionRequestV1Schema = z
  .object({
    chainId: z.literal(8453),
    profileIdentity: z.string().min(1).max(200),
    /** Idempotency handle for the attempt, so a double click reaches one. */
    attemptRequestId: z.string().min(1).max(200),
  })
  .strict();

export const B20EntryBeginSubmissionResponseV1Schema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('ready'),
      attemptId: z.string().min(1).max(200),
      payload: B20EntryWalletPayloadV1Schema,
      review: B20EntryReviewV1Schema,
      status: B20EntryOutcomeV1Schema,
      routeProof: B20EntryRouteProofSummaryV1Schema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal('refused'),
      reason: z.string().min(1).max(80),
      detail: z.string().max(400),
      status: B20EntryOutcomeV1Schema.nullable(),
    })
    .strict(),
]);

/** POST record-submission. The client reports what the WALLET did — a batch id,
 * a rejection, or a failure. It may never report a result. */
export const B20EntryRecordSubmissionRequestV1Schema = z
  .object({
    attemptId: z.string().min(1).max(200),
    result: z.enum(['submitted', 'user_rejected', 'wallet_failed', 'cancelled']),
    /** Present only for `submitted`. Everything else must not name a batch. */
    batchId: z.string().min(1).max(200).nullable(),
  })
  .strict();

/** One bounded server-side Base reconciliation pass. The hashes are lookup
 * hints from wallet_getCallsStatus; the server re-reads every receipt. An
 * empty list means retry the hashes already bound to the attempt. */
export const B20EntryReconcileSubmissionRequestV1Schema = z
  .object({
    attemptId: z.string().min(1).max(200),
    transactionHashes: z.array(HashV1Schema).max(16),
  })
  .strict();

// ---------------------------------------------------------------------------
// T69-C — the public Discover feed.
//
// Everything below is a DISPLAY projection. There is no calldata in it, no
// internal row id the client has no use for, no provider body and no
// credential — a public feed is the surface with the widest audience and the
// least context, so it carries only typed facts and the sentences that explain
// them.
//
// Numeric measurements are nullable and are NEVER defaulted to zero: "not
// measured" and "zero" are different answers, and a card showing 0.00% cost for
// an unmeasured token is a lie with a decimal point in it.
// ---------------------------------------------------------------------------

export const B20PipelineStateV1Schema = z.enum([
  'configuration_required',
  'ingestion_not_started',
  'ingestion_catching_up',
  'measurement_pending',
  'healthy',
  'degraded',
  /** T73-LIVE §8 — nobody has advanced the cursor recently. */
  'worker_stale',
  'decoder_mismatch',
  'storage_unavailable',
]);

/** §1 — why the feed looks the way it does. Public-safe facts only: no URL, no
 * credential, no raw worker error. */
export const B20PipelineStatusV1Schema = z
  .object({
    state: B20PipelineStateV1Schema,
    /** The sentence a surface shows INSTEAD of "No opportunities". */
    message: z.string().min(1),
    blocksBehind: z.number().int().min(0).nullable(),
    facts: z
      .object({
        ingestionCursorBlock: z.string().regex(/^\d+$/).nullable(),
        confirmedHead: z.string().regex(/^\d+$/).nullable(),
        lastIngestionRunAt: z.string().datetime().nullable(),
        lastIngestionResult: z.string().max(64).nullable(),
        lastMeasurementRunAt: z.string().datetime().nullable(),
        canonicalLaunchCount: z.number().int().min(0),
        launchesAwaitingMeasurement: z.number().int().min(0),
        observationCount: z.number().int().min(0),
        /** T73-LIVE §8 — the most recent measurement burst. Null when no pass
         * has ever reported; zero when one ran and nothing was due. */
        observationsLastRun: z.number().int().min(0).nullable(),
        budgetExhausted: z.boolean(),
        operatorState: z.string().max(64).nullable(),
      })
      .strict(),
  })
  .strict();

const B20CardLaunchV1Schema = z
  .object({
    tokenAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
    name: z.string(),
    symbol: z.string(),
    variant: z.enum(['asset', 'stablecoin']),
    decimals: z.number().int().min(0).max(255).nullable(),
    blockNumber: z.string().regex(/^\d+$/),
    transactionHash: z.string().regex(/^0x[0-9a-f]{64}$/),
    logIndex: z.number().int().min(0),
    detectedAt: z.string().datetime(),
    // T69-C.1 §1 — the launch time comes from the block, or it is absent.
    // `detectedAt` is when Miorail's worker arrived, which with a cursor behind
    // the head says nothing about how old a token is.
    launchedAt: z.string().datetime().nullable(),
    launchTimeSource: z.enum(['onchain_block', 'discovered']),
    ageSeconds: z.number().int().min(0).nullable(),
    canonical: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // The two must agree: a surface that reads one and not the other cannot be
    // made to show an age it does not have.
    const known = value.launchedAt !== null;
    if (
      known !== (value.launchTimeSource === 'onchain_block') ||
      known !== (value.ageSeconds !== null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['launchTimeSource'],
        message: 'launchedAt, launchTimeSource and ageSeconds must agree',
      });
    }
  });

const B20CardActionV1Schema = z
  .object({
    action: z.enum(['check_wallet', 'try_profile', 'refresh_measurement', 'none']),
    label: z.string().min(1).max(60).nullable(),
    reason: z.string().min(20).max(400),
  })
  .strict()
  .superRefine((value, ctx) => {
    // §2 — a label is present exactly when there is something to press. A
    // labelled `none` is a dead button, which is what this task removes.
    if ((value.label === null) !== (value.action === 'none')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['label'],
        message: 'an action has a label if and only if it is not "none"',
      });
    }
  });

const B20CardObservationV1Schema = z
  .object({
    observationId: HashV1Schema,
    evidenceHash: HashV1Schema,
    state: z.enum(['candidate', 'provisional', 'rejected', 'unmeasured']),
    reasonCode: z.string().max(64).nullable(),
    /** The reading layer over `state`/`reasonCode`. `aboutToken` is false
     * whenever the card is reporting what MIORAIL could not do — a surface
     * must never count one of those as a finding about the token. */
    standing: z.object({
      kind: z.enum([
        'not_measured',
        'measurement_incomplete',
        'venue_not_searched',
        'venue_not_found',
        'no_buyers_yet',
        'bought_not_sellable',
        'sale_unpriced',
        'ruled_out',
        'two_sided',
      ]),
      headline: z.string().min(1),
      detail: z.string().min(1),
      aboutToken: z.boolean(),
    }),
    headline: z.string().min(1),
    detail: z.string().min(1),
    referencePositionAtomic: z.string().regex(/^\d+$/),
    referenceQuoteAsset: z.string().regex(/^0x[0-9a-f]{40}$/),
    maxRoundTripBps: z.number().int(),
    maxExitSlippageBps: z.number().int(),
    entryRouteFound: z.boolean(),
    exitRouteFound: z.boolean(),
    entrySourceKey: z.string().max(200).nullable(),
    exitSourceKey: z.string().max(200).nullable(),
    /** What the pool's v4 hook may do, decoded from its own address. Every
     * field is a permission, never an observed behaviour. */
    poolHook: z
      .object({
        standing: z.enum(['standard', 'non_standard', 'no_hook', 'unreadable']),
        permissions: z
          .object({
            hook: z.string().regex(/^0x[0-9a-f]{40}$/),
            permissionBits: z.number().int().min(0).max(0x3fff),
            flags: z.array(z.string().max(64)).max(14),
            none: z.boolean(),
            mayChangeSwapAmounts: z.boolean(),
            mayInterceptSwaps: z.boolean(),
            mayGateLiquidity: z.boolean(),
          })
          .nullable(),
      })
      .nullable(),
    /** Launch-window buying. Null means nobody measured that window; a zero
     * count with null shares means nobody bought. Different facts. */
    launchBuyers: z
      .object({
        buyerCount: z.number().int().min(0),
        topBuyerShareBps: z.number().int().min(0).max(10_000).nullable(),
        topThreeShareBps: z.number().int().min(0).max(10_000).nullable(),
      })
      .nullable(),
    /** Explains a null launchBuyers value. Optional for wire compatibility
     * with a server deployed before the launch-window status was projected. */
    launchBuyerWindow: z
      .object({
        status: z.enum(['collecting', 'measured', 'closed_unmeasured', 'unknown']),
        closesAtBlock: z.string().regex(/^\d+$/),
      })
      .strict()
      .nullable()
      .optional(),
    optimisticReturnAtomic: z.string().regex(/^\d+$/).nullable(),
    optimisticRoundTripBps: z.number().int().min(0).nullable(),
    routeCoverage: z.enum(['complete', 'partial']),
    /** Which venue families this reading actually asked. Null means the row
     * does not record it. `routeCoverage` says whether the candidates a search
     * generated all answered; it cannot say which venues the search covered,
     * and 1,581 stored observations claim complete coverage over a search that
     * never included Uniswap v4. */
    venuesConsulted: z.array(z.string().min(1).max(64)).max(8).nullable(),
    viableRouteConfirmed: z.boolean(),
    bestRouteConfirmed: z.boolean(),
    largestPassingSizeAtomic: z.string().regex(/^\d+$/).nullable(),
    firstFailingSizeAtomic: z.string().regex(/^\d+$/).nullable(),
    capacityToleranceBps: z.number().int().min(0),
    capacityProbeCount: z.number().int().min(0),
    capacityStable: z.boolean().nullable(),
    transfersPaused: z.boolean().nullable(),
    transferPolicyState: z
      .enum(['open', 'restricted', 'unavailable', 'unsupported_by_variant'])
      .nullable(),
    transferPolicyNotice: z.string().nullable(),
    controlsComplete: z.boolean().nullable(),
    controlsBlockNumber: z.string().regex(/^\d+$/).nullable(),
    observationBlockNumber: z.string().regex(/^\d+$/),
    quoteAlignment: z.enum(['anchored', 'latest_not_anchored']),
    quoteAlignmentNotice: z.string().nullable(),
    preEntryNotice: z.string().nullable(),
    measuredAt: z.string().datetime(),
    staleAfter: z.string().datetime(),
    freshness: z.enum(['fresh', 'stale']),
  })
  .strict()
  .superRefine((observation, ctx) => {
    if (observation.launchBuyerWindow) {
      const measured = observation.launchBuyers !== null;
      if (measured !== (observation.launchBuyerWindow.status === 'measured')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['launchBuyerWindow', 'status'],
          message: 'launch buyer window status must agree with the aggregate',
        });
      }
    }
    if (observation.state === 'provisional' && !observation.preEntryNotice) {
      // §6 — the number beside it is a bound, and the sentence saying so is not
      // optional.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a provisional card must carry the pre-entry notice',
      });
    }
    if (
      (observation.state === 'rejected' || observation.state === 'unmeasured') &&
      !observation.reasonCode
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a negative card must name its reason',
      });
    }
    if (observation.quoteAlignment === 'latest_not_anchored' && !observation.quoteAlignmentNotice) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'unanchored quotes must be stated on the card',
      });
    }
    if (observation.bestRouteConfirmed && observation.routeCoverage !== 'complete') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a best-route claim needs complete coverage',
      });
    }
  });

/**
 * Fundamental Intelligence, on the wire.
 *
 * Every finding carries its provenance and the time it was collected, because
 * a state with neither is an assertion. There is no numeric field anywhere in
 * this shape and none may be added: a number here would be sorted, and a feed
 * ranked by "fundamentals" is an investment signal whatever it is called.
 *
 * `.optional()` on the card rather than required, so a client on this build
 * reads a response from a server that predates the layer without failing.
 */
const B20FundamentalFindingV1Schema = z
  .object({
    dimension: z.enum([
      'project_identity',
      'website',
      'product',
      'repository',
      'base_presence',
      'docs',
      'project_before_token',
      'development_activity',
    ]),
    state: z.enum([
      'verified',
      'unverified',
      'live',
      'found',
      'active',
      'quiet',
      'yes',
      'no',
      'unknown',
    ]),
    provenance: z.enum([
      'domain_claim_file',
      'https_probe',
      'functional_probe',
      'repository_api',
      'onchain_read',
      'timestamp_comparison',
      'not_collected',
    ]),
    observedAt: z.string().datetime().nullable(),
    /** Only ever something the PROJECT published. */
    reference: z.string().max(2048).nullable(),
    label: z.string().min(1).max(64),
    /** What the state does not claim. Required — a finding with no bound on it
     * is the thing this whole layer exists not to publish. */
    note: z.string().min(1).max(1000),
  })
  .strict();

export const B20FundamentalProfileV1Schema = z
  .object({
    identityVerified: z.boolean(),
    projectDomain: z.string().max(253).nullable(),
    standing: z.enum(['product_backed', 'verified_project', 'unverified']),
    headline: z.string().min(1).max(200),
    detail: z.string().min(1).max(1000),
    findings: z.array(B20FundamentalFindingV1Schema).max(8),
    missing: z
      .array(
        z.enum([
          'project_identity',
          'website',
          'product',
          'repository',
          'base_presence',
          'docs',
          'project_before_token',
          'development_activity',
        ]),
      )
      .max(8),
  })
  .strict()
  .superRefine((value, ctx) => {
    // The gate, on the wire. A profile that is not verified may not carry a
    // finding or a domain — which is the copycat case, refused by the schema
    // rather than by every surface remembering to check.
    if (!value.identityVerified && (value.findings.length > 0 || value.projectDomain !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'an unverified project profile may not carry findings or a domain',
      });
    }
    if (value.identityVerified && value.standing === 'unverified') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a verified identity cannot stand as unverified',
      });
    }
    // `product_backed` requires a product SHOWN TO RUN, not a page that loaded.
    const productLive = value.findings.some(
      (finding) => finding.dimension === 'product' && finding.state === 'live',
    );
    if (value.standing === 'product_backed' && !productLive) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'product_backed requires a product finding in the `live` state',
      });
    }
    // Absence of evidence is never evidence of absence.
    for (const finding of value.findings) {
      if (finding.state === 'no' && finding.dimension !== 'project_before_token') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `only project_before_token may carry a negative state, not ${finding.dimension}`,
        });
      }
    }
  });

export const B20OpportunityCardV1Schema = z
  .object({
    schemaVersion: z.literal('b20-opportunity-card/v1'),
    launch: B20CardLaunchV1Schema,
    observation: B20CardObservationV1Schema.nullable(),
    /** Null means this server did not run the projection — distinct from the
     * unverified profile, which is the answer for almost every launch. */
    project: B20FundamentalProfileV1Schema.nullable().optional(),
    canCheckProfile: z.boolean(),
    action: B20CardActionV1Schema,
    notMeasured: z.array(z.string()).max(20),
  })
  .strict()
  .superRefine((value, ctx) => {
    // §3, on the wire. A card whose evidence holds for every wallet must never
    // reach a surface carrying an action that invites a wallet-specific check
    // — the schema refuses the combination rather than trusting each surface
    // to re-derive the rule.
    const walletIndependent =
      value.observation?.state === 'rejected' &&
      value.observation.reasonCode !== null &&
      ['not_b20', 'uninitialized', 'transfers_paused', 'no_entry_route', 'no_exit_route'].includes(
        value.observation.reasonCode,
      ) &&
      value.observation.freshness === 'fresh';
    if (walletIndependent && value.action.action === 'check_wallet') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['action'],
        message: 'a fresh wallet-independent rejection may not offer a wallet check',
      });
    }
  });

/** T73 §2 — a leader carries the BOUND, never a single capacity figure. */
const B20CapacityLeaderV1Schema = z
  .object({
    tokenAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
    symbol: z.string(),
    name: z.string(),
    decimals: z.number().int().min(0).max(255).nullable(),
    largestPassingSizeAtomic: z.string().regex(/^\d+$/),
    capacityCoverageBps: z.number().int().nonnegative().safe(),
    firstFailingSizeAtomic: z.string().regex(/^\d+$/).nullable(),
    toleranceBps: z.number().int().min(1).max(10_000),
    optimisticRoundTripBps: z.number().int().min(0).nullable(),
    roundTripReferenceBps: z.number().int().min(1).max(10_000),
    profileStatus: z.enum(['within_reference', 'outside_round_trip_reference', 'not_measured']),
    state: z.enum(['candidate', 'provisional', 'rejected', 'unmeasured']),
    reasonCode: z.string().max(64).nullable(),
    measuredAt: z.string().datetime(),
    staleAfter: z.string().datetime(),
    observationBlockNumber: z.string().regex(/^\d+$/),
    freshness: z.enum(['fresh', 'stale']),
  })
  .strict()
  .superRefine((value, ctx) => {
    const expected =
      value.optimisticRoundTripBps === null
        ? 'not_measured'
        : value.optimisticRoundTripBps <= value.roundTripReferenceBps
          ? 'within_reference'
          : 'outside_round_trip_reference';
    if (value.profileStatus !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['profileStatus'],
        message: 'profile status must match the measured round trip and reference',
      });
    }
  });

/** §3 — a mover carries both quotes and the REAL interval, so "24h" can be
 * checked rather than taken on trust. */
const B20MeasuredMoverV1Schema = z
  .object({
    tokenAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
    symbol: z.string(),
    name: z.string(),
    decimals: z.number().int().min(0).max(255),
    changeBps: z.number().int(),
    label: z.literal('24h change from Miorail measured quotes'),
    entryOutputThenAtomic: z.string().regex(/^\d+$/),
    entryOutputNowAtomic: z.string().regex(/^\d+$/),
    referencePositionAtomic: z.string().regex(/^\d+$/),
    intervalSeconds: z.number().int().min(0),
    baselineMeasuredAt: z.string().datetime(),
    measuredAt: z.string().datetime(),
    largestPassingSizeAtomic: z.string().regex(/^\d+$/),
    optimisticRoundTripBps: z.number().int().min(0),
    roundTripReferenceBps: z.number().int().min(1).max(10_000),
    profileStatus: z.enum(['within_reference', 'outside_round_trip_reference']),
    // A profile miss is still a measured observation, but no other rejection is.
    state: z.enum(['provisional', 'rejected']),
    reasonCode: z.string().max(64).nullable(),
    freshness: z.enum(['fresh', 'stale']),
  })
  .strict()
  .superRefine((value, ctx) => {
    const expected =
      value.optimisticRoundTripBps <= value.roundTripReferenceBps
        ? 'within_reference'
        : 'outside_round_trip_reference';
    if (value.profileStatus !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['profileStatus'],
        message: 'profile status must match the measured round trip and reference',
      });
    }
    if (
      value.state === 'rejected' &&
      (value.reasonCode !== 'round_trip_above_tolerance' ||
        value.profileStatus !== 'outside_round_trip_reference')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['state'],
        message: 'only a measured round-trip reference miss can be a rejected mover',
      });
    }
    if (value.state === 'provisional' && value.profileStatus !== 'within_reference') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['state'],
        message: 'a provisional mover must be within the round-trip reference',
      });
    }
  });

export const B20MarketRailsResponseV1Schema = z
  .object({
    pipeline: B20PipelineStatusV1Schema,
    capacityLeaders: z.array(B20CapacityLeaderV1Schema).max(10),
    movers: z.array(B20MeasuredMoverV1Schema).max(10),
    collectingHistory: z.boolean(),
    toleranceBps: z.number().int().min(1).max(10_000),
    moveLabel: z.literal('24h change from Miorail measured quotes'),
    moveNote: z.string().min(20),
    serverTime: z.string().datetime(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // §5 — "Collecting 24h history" is only true when there is nothing to show
    // AND time is the reason. Saying it beside a populated list would tell a
    // user the numbers in front of them are provisional in a way they are not.
    if (value.collectingHistory && value.movers.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['collectingHistory'],
        message: 'a populated movers list is not still collecting history',
      });
    }
  });

/**
 * The universe, counted — the shape a planner asks for instead of paging.
 *
 * `inspected` counts canonical launches in the window. `completed` and
 * `incomplete` partition that corpus by the standing of each launch's latest
 * supported stored reading. None of these is a count of every token on Base.
 * The `aboutToken` flag rides along on each standing row for the same reason it
 * rides on a card: a bucket whose flag is false counts what Miorail could not
 * measure, and a reader that adds it to a finding has produced a number nobody
 * measured.
 */
export const B20UniverseSummaryV1Schema = z
  .object({
    window: z
      .object({
        maxLaunchAgeMs: z.number().int().positive(),
        launches: z.number().int().min(0),
        inspected: z.number().int().min(0),
        completed: z.number().int().min(0),
        incomplete: z.number().int().min(0),
        /** False when storage could not establish the complete window. */
        complete: z.boolean(),
      })
      .strict()
      .superRefine((window, ctx) => {
        if (window.launches !== window.inspected) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['launches'],
            message: 'launches is the compatibility alias of inspected',
          });
        }
        if (window.completed + window.incomplete !== window.inspected) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['completed'],
            message: 'completed and incomplete must partition inspected',
          });
        }
      }),
    standing: z
      .array(
        z
          .object({
            kind: z.string().min(1).max(64),
            group: z.enum(['bought_not_sellable', 'two_sided', 'no_buyers_yet', 'miorail_limit']),
            count: z.number().int().min(0),
            aboutToken: z.boolean(),
          })
          .strict(),
      )
      .max(32),
    sections: z
      .array(
        z
          .object({
            group: z.enum(['bought_not_sellable', 'two_sided', 'no_buyers_yet', 'miorail_limit']),
            label: z.string().min(1),
            count: z.number().int().min(0),
          })
          .strict(),
      )
      .max(8),
    reasonCodes: z
      .array(z.object({ code: z.string().min(1).max(64), count: z.number().int().min(0) }).strict())
      .max(64),
    venues: z
      .array(
        z
          .object({ venues: z.string().min(1).max(200).nullable(), count: z.number().int().min(0) })
          .strict(),
      )
      .max(16),
    buyers: z
      .array(z.object({ band: z.string().min(1).max(32), count: z.number().int().min(0) }).strict())
      .max(8),
    computedAt: z.string().datetime(),
    cachedForMs: z.number().int().min(0),
    caveats: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type B20UniverseSummaryV1 = z.infer<typeof B20UniverseSummaryV1Schema>;

export const B20OpportunityFeedResponseV1Schema = z
  .object({
    pipeline: B20PipelineStatusV1Schema,
    cards: z.array(B20OpportunityCardV1Schema).max(100),
    nextCursor: z.string().max(500).nullable(),
    /** Server time, so a client computes staleness against the same clock the
     * observations were stamped with. */
    serverTime: z.string().datetime(),
  })
  .strict();

export const B20OpportunityDetailResponseV1Schema = z
  .object({
    card: B20OpportunityCardV1Schema,
    /** Bounded history, newest first. Kept visible when stale — it is what was
     * true when somebody looked. */
    history: z
      .array(
        z
          .object({
            state: z.enum(['candidate', 'provisional', 'rejected', 'unmeasured']),
            reasonCode: z.string().max(64).nullable(),
            observationBlockNumber: z.string().regex(/^\d+$/),
            optimisticRoundTripBps: z.number().int().min(0).nullable(),
            largestPassingSizeAtomic: z.string().regex(/^\d+$/).nullable(),
            measuredAt: z.string().datetime(),
            staleAfter: z.string().datetime(),
          })
          .strict(),
      )
      .max(50),
    pipeline: B20PipelineStatusV1Schema,
    serverTime: z.string().datetime(),
  })
  .strict();

// ---------------------------------------------------------------------------
// B20 Intelligence Copilot — one exact Discover observation, read-only.
//
// The client supplies references, never evidence. The server rehydrates the
// canonical observation and refuses a changed id/hash before answering. This
// prevents an old browser card from being narrated as current evidence.
// ---------------------------------------------------------------------------

export const B20CopilotQuestionKindV1Schema = z.enum([
  'summary',
  'why_rejected',
  'unusual',
  'missing_evidence',
  'explain_hook',
  'exit_capacity',
  'compare_previous',
]);

export const B20CopilotAskRequestV1Schema = z
  .object({
    schemaVersion: z.literal('b20-copilot-ask/v1'),
    tokenAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
    observationId: HashV1Schema.nullable(),
    evidenceHash: HashV1Schema.nullable(),
    question: z.string().trim().min(2).max(500),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.observationId === null) !== (value.evidenceHash === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['observationId'],
        message: 'observationId and evidenceHash must both be present or both be null',
      });
    }
  });

const B20CopilotFactV1Schema = z
  .object({
    label: z.string().min(1).max(80),
    value: z.string().min(1).max(500),
    tone: z.enum(['neutral', 'positive', 'warning']),
  })
  .strict();

export const B20CopilotAskResponseV1Schema = z
  .object({
    schemaVersion: z.literal('b20-copilot-answer/v1'),
    /**
     * Which of the two answers the reader got.
     *
     * `deterministic_evidence` is the sentence this rail builds from the stored
     * observation. `verified_narration` is a model's rephrasing of the SAME
     * evidence bundle, kept only after every number in it was found in that
     * bundle and no recommendation vocabulary was used. The distinction is on
     * the wire because a reader deserves to know which one they are reading,
     * and because a surface may choose to show only the first.
     */
    answerSource: z.enum(['deterministic_evidence', 'verified_narration']),
    questionKind: B20CopilotQuestionKindV1Schema,
    subject: z
      .object({
        tokenAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
        symbol: z.string(),
        name: z.string(),
      })
      .strict(),
    observation: z
      .object({
        observationId: HashV1Schema,
        evidenceHash: HashV1Schema,
        blockNumber: z.string().regex(/^\d+$/),
        measuredAt: z.string().datetime(),
        freshness: z.enum(['fresh', 'stale']),
      })
      .strict()
      .nullable(),
    answer: z.string().min(1).max(4000),
    facts: z.array(B20CopilotFactV1Schema).max(16),
    missingEvidence: z.array(z.string().min(1).max(300)).max(20),
    caveats: z.array(z.string().min(1).max(500)).min(1).max(12),
    routeHandoff: z
      .object({
        label: z.literal('Open in Routes'),
        goal: z.string().min(1).max(500),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type B20CopilotAskRequestV1 = z.infer<typeof B20CopilotAskRequestV1Schema>;
export type B20CopilotAskResponseV1 = z.infer<typeof B20CopilotAskResponseV1Schema>;

// ---------------------------------------------------------------------------
// Stage 07 — the global console. Read-only, and no single card to pin.
//
// The per-card copilot refuses when the observation it was opened on has since
// changed, because the client holds a reference to one exact measurement. A
// question about the universe has no such reference, so the honest substitute
// is on the response instead: `reads` says which bounded reads ran and what
// they returned, and `serverTime` says when. A reader can see what the answer
// was built from rather than being asked to trust that it was current.
// ---------------------------------------------------------------------------

export const B20ConsoleScopeV1Schema = z.enum(['explore', 'investigate', 'changes', 'portfolio']);

export const B20ConsoleAskRequestV1Schema = z
  .object({
    schemaVersion: z.literal('b20-console-ask/v1'),
    scope: B20ConsoleScopeV1Schema,
    question: z.string().trim().min(2).max(500),
    /**
     * Tokens the reader selected. Addresses only — a symbol is not an
     * identifier on Base, and resolving one would be Miorail guessing which
     * token was meant and then measuring the guess.
     *
     * The cap depends on the scope and is checked below rather than here.
     * Investigate is a side-by-side a person reads, so five; Portfolio is
     * whatever a wallet holds, bounded at the same 25 the watch endpoint uses
     * because each position is its own read.
     */
    tokenAddresses: z
      .array(z.string().regex(/^0x[0-9a-fA-F]{40}$/))
      .max(25)
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const limit = value.scope === 'portfolio' ? 25 : 5;
    if ((value.tokenAddresses?.length ?? 0) > limit) {
      // Refused, never truncated. Silently dropping the sixth token would
      // answer a comparison the caller did not ask for and label it as theirs.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tokenAddresses'],
        message: `${value.scope} accepts at most ${limit} token addresses`,
      });
    }
  });

export const B20ConsoleAskResponseV1Schema = z
  .object({
    schemaVersion: z.literal('b20-console-answer/v1'),
    /** The scope that ANSWERED, which is not always the one that was asked
     * for: an address in the question moves the answer to that token. A
     * surface reads this to label what it is showing. */
    scope: B20ConsoleScopeV1Schema,
    intent: z.enum([
      'universe_counts',
      'find_bought_not_sellable',
      'find_two_sided',
      'find_not_searched',
      'find_verified_projects',
      'find_possible_public_context',
      'find_needs_evidence',
      'find_research_candidates',
      'compare_tokens',
      'measured_changes',
      'rank_positions',
      'unsupported',
    ]),
    answerSource: z.enum(['deterministic_evidence', 'verified_narration']),
    answer: z.string().min(1).max(4000),
    facts: z
      .array(
        z
          .object({
            label: z.string().min(1).max(80),
            value: z.string().min(1).max(500),
            tone: z.enum(['neutral', 'positive', 'warning']),
          })
          .strict(),
      )
      .max(16),
    missingEvidence: z.array(z.string().min(1).max(300)).max(20),
    caveats: z.array(z.string().min(1).max(500)).min(1).max(12),
    /** What this answer was built from. Never empty on an answered question. */
    reads: z
      .array(
        z.object({ tool: z.string().min(1).max(40), detail: z.string().min(1).max(300) }).strict(),
      )
      .max(8),
    serverTime: z.string().datetime(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Stage 09 — Launch Context. Read on request, about one token.
//
// The shape is built around one refusal: `corpus` is present only when the
// launch transaction went STRAIGHT to the B20 factory. Measured on the first
// 300 stored launches, every repeated sender went through a relayer or the
// ERC-4337 EntryPoint, so counting launches by `tx.from` would have grouped
// unrelated projects under one address. There is no field here that can carry
// a count the domain layer refused to make.
//
// There is also no score. `verifiedLabel` is a fraction and the checklist is
// beside it, because a single number folding unlike evidence together would be
// sorted, and a ranked list of tokens is an investment signal.
// ---------------------------------------------------------------------------

export const B20SenderRelationV1Schema = z.enum([
  'direct',
  'bundler',
  'intermediary',
  'contract_creation',
]);

export const B20ClaimLinkV1Schema = z.enum(['launch_sender', 'domain_file', 'project_publication']);

export const B20LaunchContextResponseV1Schema = z
  .object({
    schemaVersion: z.literal('b20-launch-context/v1'),
    tokenAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
    headline: z.string().min(1).max(200),
    reading: z.discriminatedUnion('status', [
      z.object({ status: z.literal('not_read') }).strict(),
      z
        .object({
          status: z.literal('read'),
          deployerAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
          relation: B20SenderRelationV1Schema,
          readAt: z.string().datetime(),
        })
        .strict(),
      z.object({ status: z.literal('transaction_absent'), readAt: z.string().datetime() }).strict(),
    ]),
    corpus: z
      .object({
        launchCount: z.number().int().min(0),
        standingCounts: z
          .array(
            z.object({ kind: z.string().min(1).max(64), count: z.number().int().min(0) }).strict(),
          )
          .max(20),
        /** The breakdown's own denominator. It is NOT `launchCount`: one live
         * sender has 359 launches and the breakdown reads 25 of them. */
        standingSampleSize: z.number().int().min(0),
        coverage: z
          .object({ launchesRead: z.number().int().min(0), launchesTotal: z.number().int().min(0) })
          .strict(),
      })
      .strict()
      .nullable(),
    claim: z
      .object({
        status: z.enum(['no_claim', 'unverified', 'verified', 'refuted']),
        headline: z.string().min(1).max(200),
        detail: z.string().min(1).max(600),
        verifiedLinks: z.array(B20ClaimLinkV1Schema).max(3),
        refutedLinks: z.array(B20ClaimLinkV1Schema).max(3),
        uncheckedLinks: z.array(B20ClaimLinkV1Schema).max(3),
        verifiedLabel: z.string().regex(/^\d+ of \d+$/),
        /** When the links were last checked. A verified link is only as current
         * as the check that verified it, and the fundamental layer hangs its
         * identity timestamp off exactly this. */
        lastCheckedAt: z.string().datetime().nullable(),
      })
      .strict(),
    caveats: z.array(z.string().min(1).max(500)).min(1).max(10),
    serverTime: z.string().datetime(),
  })
  .strict();

export type B20LaunchContextResponseV1 = z.infer<typeof B20LaunchContextResponseV1Schema>;

export type B20ConsoleAskRequestV1 = z.infer<typeof B20ConsoleAskRequestV1Schema>;
export type B20ConsoleAskResponseV1 = z.infer<typeof B20ConsoleAskResponseV1Schema>;

export type B20PipelineStatusV1Wire = z.infer<typeof B20PipelineStatusV1Schema>;
export type B20OpportunityCardV1Wire = z.infer<typeof B20OpportunityCardV1Schema>;
export type B20OpportunityFeedResponseV1 = z.infer<typeof B20OpportunityFeedResponseV1Schema>;
export type B20OpportunityDetailResponseV1 = z.infer<typeof B20OpportunityDetailResponseV1Schema>;

export const B20EntryStatusResponseV1Schema = z
  .object({
    review: B20EntryReviewV1Schema,
    status: B20EntryOutcomeV1Schema,
    routeProof: B20EntryRouteProofSummaryV1Schema.nullable(),
    expiresAt: z.string().min(1).max(60),
    expired: z.boolean(),
  })
  .strict();

/** The authenticated read. Tenant- AND wallet-scoped; another wallet gets the
 * not-found answer a nonexistent plan gets. */
export const B20EntryPlanResponseV1Schema = z
  .object({
    review: B20EntryReviewV1Schema,
    expiresAt: z.string().min(1).max(60),
    /** Derived, never stored as state: expiry is a fact about a clock, and
     * rewriting immutable evidence to record the passage of time would destroy
     * the evidence. */
    expired: z.boolean(),
    executionAvailable: z.boolean(),
    executionUnavailableReason: z.literal('submission_not_wired').nullable(),
    status: B20EntryOutcomeV1Schema,
    routeProof: B20EntryRouteProofSummaryV1Schema.nullable(),
  })
  .strict();

export const B20EntryPrepareRequestV1Schema = z
  .object({
    chainId: z.literal(8453),
    /** Restated by the client so a mismatch is caught rather than assumed. */
    profileIdentity: z.string().min(1).max(200),
    /** Idempotency handle. The same one returns the same plan. */
    requestId: z.string().min(1).max(200),
  })
  .strict();

export const B20EntryPrepareResponseV1Schema = z
  .object({
    outcome: z.enum(['prepared', 'refused']),
    /** Named exactly, so a user knows which binding failed. Never a provider
     * body, an endpoint or a key. */
    refusalReason: z.string().min(1).max(80).nullable(),
    refusalDetail: z.string().max(400).nullable(),
    clearanceId: z.string().min(1).max(200),
    blueprintHash: z
      .string()
      .regex(/^0x[0-9a-f]{64}$/)
      .nullable(),
    tokenAddress: AddressV1Schema,
    /** What the user spends, and what the plan expects back. */
    positionAtomic: z.string().regex(/^[1-9][0-9]{0,17}$/),
    expectedOutputAtomic: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .nullable(),
    minimumOutputAtomic: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .nullable(),
    entrySourceKey: z.string().max(300).nullable(),
    coverage: z.enum(['complete', 'partial']).nullable(),
    viableRouteConfirmed: z.boolean(),
    bestRouteConfirmed: z.boolean(),
    certifiedControlBlockNumber: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .nullable(),
    prepareControlBlockNumber: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .nullable(),
    clearanceExpiresAt: z.string().min(1).max(60),
    /** Unsigned calls for the user's own wallet to approve. Present only when
     * every gate, the kernel AND the simulation passed. */
    calls: z
      .array(
        z
          .object({
            to: AddressV1Schema,
            data: z
              .string()
              .regex(/^0x[0-9a-fA-F]*$/)
              .max(20_000),
            value: z.string().regex(/^(0|[1-9][0-9]*)$/),
          })
          .strict(),
      )
      .max(2)
      .nullable(),
    preparedAt: z.string().min(1).max(60),
    // T68F-A — the stored plan. Present only when preparation persisted one.
    planId: z.string().min(1).max(200).nullable(),
    review: B20EntryReviewV1Schema.nullable(),
    /** False for the whole of T68F-A. Stated as its own field so a surface
     * cannot mistake missing wiring for a provider failure or a token
     * rejection — the plan is sound, the submission path does not exist yet. */
    executionAvailable: z.boolean(),
    executionUnavailableReason: z.literal('submission_not_wired').nullable(),
  })
  .strict();

export const B20InspectResponseV1Schema = z
  .object({
    snapshotId: z.string().min(1).max(200),
    status: z.enum(['complete', 'partial', 'not_b20', 'failed']),
    /** True when the answer came from a stored snapshot inside the TTL rather
     * than from a fresh read. Shown, not hidden: a cached block is a
     * different claim from a current one. */
    cached: z.boolean(),
    card: B20ControlCardResponseV1Schema,
    evidence: z.array(B20EvidenceV1Schema).max(64),
    /** Absent on a cache hit and on a first observation. Absent, not empty:
     * an empty change list reads as "nothing changed", which is a different
     * claim from "there was nothing to compare against". */
    watch: B20ControlWatchV1Schema.optional(),
  })
  .strict();
export type B20InspectResponseV1 = z.infer<typeof B20InspectResponseV1Schema>;

// ---------------------------------------------------------------------------
// T67C.2 — submission recovery and public proof wire contracts.
//
// The recovery request carries HANDLES only. There is deliberately no field
// for calls, calldata, a router, a recipient or a receipt: the server rebuilds
// every one of those from its own records, so a tampered client cannot widen
// what a recovery is allowed to touch. The same rule the approve path has
// followed since T57.
// ---------------------------------------------------------------------------

export const SubmissionGoalWireV1Schema = z.enum(['swap', 'earn', 'nft']);

export const SubmissionAttemptStatusWireV1Schema = z.enum([
  'wallet_pending',
  'batch_observed',
  'submitted',
  'submitted_unknown',
  'confirmed',
  'failed',
  'cancelled',
  'abandoned',
]);

export const SubmissionAttemptCreateRequestV1Schema = z
  .object({
    walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    goal: SubmissionGoalWireV1Schema,
    routeRunId: z.string().min(1).max(200),
    blueprintId: z.string().min(1).max(200),
    approvedCallsHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  })
  .strict();
export type SubmissionAttemptCreateRequestV1 = z.infer<
  typeof SubmissionAttemptCreateRequestV1Schema
>;

export const SubmissionAttemptWireV1Schema = z
  .object({
    id: z.string().min(1).max(200),
    walletAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
    chainId: z.literal(8453),
    goal: SubmissionGoalWireV1Schema,
    routeRunId: z.string().min(1).max(200),
    blueprintId: z.string().min(1).max(200),
    proofId: z.string().min(1).max(200).nullable(),
    approvedCallsHash: z.string().regex(/^0x[0-9a-f]{64}$/),
    /** Null is the honest unrecoverable state, and the UI says so rather than
     * offering a retry that would send a second transaction. */
    batchId: z.string().min(1).max(200).nullable(),
    status: SubmissionAttemptStatusWireV1Schema,
    errorCode: z.string().min(1).max(120).nullable(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    completedAt: z.string().min(1).nullable(),
  })
  .strict();
export type SubmissionAttemptWireV1 = z.infer<typeof SubmissionAttemptWireV1Schema>;

export const SubmissionAttemptResponseV1Schema = z
  .object({ attempt: SubmissionAttemptWireV1Schema })
  .strict();
export type SubmissionAttemptResponseV1 = z.infer<typeof SubmissionAttemptResponseV1Schema>;

/** The bind request. `batchId` and nothing else: transaction hashes and
 * receipts are recorded through the submission route, which knows how to check
 * them against a proof. */
export const SubmissionAttemptBatchRequestV1Schema = z
  .object({ batchId: z.string().min(1).max(200) })
  .strict();
export type SubmissionAttemptBatchRequestV1 = z.infer<typeof SubmissionAttemptBatchRequestV1Schema>;

export const RecoverableSubmissionAttemptsResponseV1Schema = z
  .object({ attempts: z.array(SubmissionAttemptWireV1Schema).max(20) })
  .strict();
export type RecoverableSubmissionAttemptsResponseV1 = z.infer<
  typeof RecoverableSubmissionAttemptsResponseV1Schema
>;

export const PublicProofShareResponseV1Schema = z
  .object({
    publicId: z.string().regex(/^[0-9a-f]{48,}$/),
    url: z.string().min(1).max(300),
    createdAt: z.string().min(1),
  })
  .strict();
export type PublicProofShareResponseV1 = z.infer<typeof PublicProofShareResponseV1Schema>;
