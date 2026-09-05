import { z } from 'zod';

// ---------------------------------------------------------------------------
// The output half of the private tool contract.
//
// Until this file existed, every private tool advertised an `inputSchema` and
// nothing on the way back. That asymmetry is worst exactly where it matters
// most: `miorail_get_stock_base_mcp_action` hands a client EIP-5792 calls, and
// the client had no formal way to check that what arrived is the shape Miorail
// claims to produce. It had to trust prose.
//
// Two rules govern what is written here.
//
// The first is that a schema must describe the payload that EXISTS, not the
// payload we would like. The SDK validates `structuredContent` against these
// on every successful call, so a wrong schema does not produce a warning — it
// turns a working execution tool into `Output validation error`. Where a
// facade body is spread into a response, the object stays open (`passthrough`)
// and only the fields this layer itself guarantees are pinned.
//
// The second is that the fields worth pinning are the ones a caller would
// otherwise have to infer: the hashes, the calls, and — above all — which
// responses carry something executable and which deliberately do not. A
// refusal that says `action: null` in a schema is a refusal a client can
// detect without reading English.
// ---------------------------------------------------------------------------

const Hash32V1 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const HexDataV1 = z.string().regex(/^0x[0-9a-fA-F]*$/);
const AddressV1 = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

/** §7 — carried on every private response, refusals included. */
const CaveatsV1 = z
  .object({
    approval: z.string().min(1),
    qualification: z.string().min(1),
    onePlanOneSubmission: z.string().min(1),
    entryOnly: z.string().min(1),
  })
  .strict();

const CallV1 = z
  .object({ to: AddressV1, value: HexDataV1, data: HexDataV1 })
  .strict();

/**
 * The two chain-id encodings, stated rather than smoothed over.
 *
 * `miorail_get_base_mcp_action` returns the hex literal `0x2105` because that
 * is what the Base Account contract pins. `miorail_get_stock_base_mcp_action`
 * returns the number 8453, because a prepared blueprint carries a numeric
 * chain id. Both tell the caller to pass the batch to Base MCP `send_calls`
 * unchanged, so the difference is real and a client that learned one shape
 * meets the other unprepared.
 *
 * Writing the schemas is what surfaced it. They are declared exactly as they
 * are — narrowing one to match the other here would hide a wire difference
 * behind a validator instead of reporting it.
 */
const HexChainIdV1 = z.literal('0x2105');
const NumericChainIdV1 = z.literal(8453);

const RepresentationIdentityV1 = z
  .object({
    chainId: NumericChainIdV1,
    tokenAddress: AddressV1,
    caip10: z.string().regex(/^eip155:8453:0x[0-9a-fA-F]{40}$/),
    underlyingKey: z.string().min(1),
    issuerId: z.string().min(1),
    issuerInstrumentKey: z.string().min(1),
    representationKind: z.string().min(1),
  })
  .strict();

/** §1 — a review link and an identity. No financial term, by construction. */
export const MiorailPrepareStockActionOutputV1Schema = z
  .object({
    schemaVersion: z.literal('stock-action-draft/v1'),
    actionDraftId: z.string().min(1),
    representation: RepresentationIdentityV1,
    question: z
      .object({
        direction: z.enum(['buy', 'sell']),
        requestedCashAtomic: z.string().regex(/^[0-9]+$/),
        destination: z.literal('USDC'),
        sizeBasis: z.string().min(1),
        routePolicyKey: Hash32V1,
      })
      .strict(),
    reviewRequired: z.literal(true),
    reviewUrl: z.string().min(1),
    expiresAt: z.string().min(1),
    // The four literals a reader can check instead of trusting the prose above
    // them. A draft that ever carried terms would fail this schema, not a
    // review.
    currentTermsIncluded: z.literal(false),
    createsApproval: z.literal(false),
    createsCalldata: z.literal(false),
    createsTransaction: z.literal(false),
    nextStep: z.string().min(1),
    caveats: CaveatsV1,
  })
  .strict();

/** §2 — the executable stock request. The only private output whose success
 * branch is required to carry calls. */
export const MiorailGetStockBaseMcpActionOutputV1Schema = z
  .object({
    schemaVersion: z.literal('stock-action-execution/v1'),
    outcome: z.literal('ready'),
    clearanceId: z.string().min(1),
    actionDraftId: z.string().min(1),
    representation: RepresentationIdentityV1,
    action: z
      .object({
        chainId: NumericChainIdV1,
        from: AddressV1,
        calls: z.array(CallV1).min(1),
        atomicRequired: z.literal(true),
      })
      .strict(),
    blueprintId: z.string().min(1),
    blueprintHash: Hash32V1,
    /**
     * The join key of everything that happens after this response.
     *
     * `record_base_mcp_submission` cannot write a row without it, and Route
     * Proof cannot reconcile a row that was never written — a submission is
     * only ever recorded against an APPROVED Blueprint. It was absent here for
     * as long as this surface skipped the approval step, which is why a trade
     * that reached the chain left no record on either surface.
     */
    approvedCallsHash: Hash32V1,
    /** When the quote these calls were built on stops being current. The one
     * signing path refuses to open a wallet past it. */
    quoteExpiry: z.string().min(1),
    routeRunId: z.string().min(1),
    blueprintStatus: z.string().min(1),
    reviewConfirmed: z.literal(true),
    approvalRequired: z.literal(true),
    instructions: z.string().min(1),
    caveats: CaveatsV1,
  })
  .strict();

/**
 * §3 — the live check.
 *
 * Open on purpose: the simulation facade's own body is spread into this
 * response, and that body is the web surface's contract rather than this
 * layer's. What is pinned is what this layer adds — and `qualified` is pinned
 * as a boolean precisely so a caller stops inferring it from the presence of a
 * clearance id.
 */
export const MiorailCheckExitProfileOutputV1Schema = z
  .object({
    qualified: z.boolean(),
    referenceProfile: z
      .object({
        quoteAsset: z.string().min(1),
        positionAtomic: z.string().regex(/^[0-9]+$/),
        maxRoundTripBps: z.number().int(),
        maxExitSlippageBps: z.number().int(),
      })
      .strict(),
    profileIdentity: z.string().min(1),
    nextStep: z.string().min(1),
    caveats: CaveatsV1,
  })
  .passthrough();

/** §4 — the review, and the field that says it is not executable. */
export const MiorailPrepareB20EntryOutputV1Schema = z
  .object({
    outcome: z.string().min(1),
    planId: z.string().min(1).nullable(),
    executionAvailable: z.boolean(),
    // Present only on the prepared branch; a refusal carries the reason pair
    // instead. Declared nullish rather than split into a union because the SDK
    // advertises an object shape, and a union would have to be flattened here
    // anyway.
    callsHash: Hash32V1.nullish(),
    blueprintHash: Hash32V1.nullish(),
    chainId: NumericChainIdV1.nullish(),
    wallet: AddressV1.nullish(),
    expiresAt: z.string().nullish(),
    clearanceExpiresAt: z.string().nullish(),
    review: z.unknown().optional(),
    executionUnavailableReason: z.string().nullish(),
    refusalReason: z.string().nullish(),
    refusalDetail: z.string().nullish(),
    // Literal `null`, not "absent": §4 returns a review and never the bytes,
    // and a client can assert that rather than believe it.
    calls: z.null().optional(),
    callsNotice: z.string().min(1).optional(),
    caveats: CaveatsV1,
  })
  .passthrough();

/** §5 — the persisted calls, or a refusal that carries none. */
export const MiorailGetBaseMcpActionOutputV1Schema = z
  .object({
    outcome: z.enum(['ready', 'refused']),
    attemptId: z.string().min(1).nullish(),
    // `null` on every refusal branch. This is the single most useful assertion
    // on the private surface: no executable batch without `outcome: 'ready'`.
    action: z
      .object({
        chainId: HexChainIdV1,
        from: AddressV1,
        calls: z.array(CallV1).min(1),
        atomicRequired: z.literal(true),
      })
      .strict()
      .nullable(),
    callsHash: Hash32V1.nullish(),
    /** Recomputed from the returned bytes, so a caller can prove the two agree. */
    callsHashOfReturnedCalls: Hash32V1.nullish(),
    planId: z.string().min(1).nullish(),
    expiresAt: z.string().nullish(),
    review: z.unknown().optional(),
    instructions: z.string().min(1).optional(),
    reason: z.string().nullish(),
    detail: z.string().nullish(),
    status: z.unknown().optional(),
    caveats: CaveatsV1,
  })
  .passthrough();

/** §7 — what was recorded, including the branch that deliberately records
 * nothing and locks the plan. */
export const MiorailRecordSubmissionOutputV1Schema = z
  .object({
    outcome: z.enum(['recorded', 'not_recorded']),
    reportedResult: z.enum(['submitted', 'user_rejected', 'unknown']).optional(),
    reason: z.string().nullish(),
    detail: z.string().nullish(),
    guidance: z.string().min(1).optional(),
    caveats: CaveatsV1,
  })
  .passthrough();

/** §8 — the reconciled state, plus the sentence that stops it being upgraded. */
export const MiorailExecutionStatusOutputV1Schema = z
  .object({
    stateMeaning: z.string().nullable(),
    caveats: CaveatsV1,
  })
  .passthrough();

/**
 * Phase 17.7 §9 — a measurement that just ran, in the shape a read returns.
 *
 * Deliberately the SAME envelope `compare_market_reality` returns, with one
 * block added. An assistant that measures and then reads must not have to
 * learn two shapes to notice that the answer changed, and a second shape is a
 * second place for the not-established wording to go missing.
 *
 * `comparison` is advertised loosely for the reason its public twin is: SDK
 * 1.29 serialises Zod's URL validator in a way AJV rejects while listing tools.
 * The full payload is still parsed by the canonical schema before it reaches
 * the protocol — the strictness is in the code path, not in the advertisement.
 */
export const MiorailMeasureMarketRealityOutputV1Schema = z
  .object({
    schemaVersion: z.literal('miorail-agent-market-reality/v1'),
    chain: z.literal('base'),
    quoteOnly: z.literal(true),
    executionEvidenceIncluded: z.literal(false),
    /**
     * What this call actually cost, and what it reused.
     *
     * Present so a looping assistant can see that its second identical request
     * did no work: `measured` counts representations this call really quoted,
     * `joinedInFlight` counts those already being measured for somebody else,
     * and `reusedCooldown` counts those measured moments ago. A caller reading
     * `measured: 0` beside `reusedCooldown: 3` is being told the answer is
     * fresh AND that pressing again buys nothing.
     */
    measurement: z
      .object({
        measured: z.number().int().min(0),
        reusedOpen: z.number().int().min(0),
        reusedCooldown: z.number().int().min(0),
        excludedZeroSupply: z.number().int().min(0),
        unresolved: z.number().int().min(0),
        joinedInFlight: z.number().int().min(0),
      })
      .passthrough(),
    miorailSummary: z.object({ summary: z.string() }).passthrough(),
    comparison: z.object({ schemaVersion: z.literal('market-reality/v2') }).passthrough(),
  })
  .passthrough();
