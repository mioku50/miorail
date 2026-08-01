import { z } from 'zod';

// ---------------------------------------------------------------------------
// T67D — contracts for the o1 Trading API compatibility gate.
//
// These schemas describe what o1 SENDS, not what Miorail trusts. Everything is
// `.strict()`: a field this gate has never seen is a field nobody has judged,
// and silently accepting it is how an unreviewed parameter reaches a decode.
//
// Nothing here can carry a private key or a signed transaction. That is not an
// omission — `O1UnsignedTransactionV1` has no `signed` member and the request
// schema has no key field, so the type system refuses the shapes the official
// sample uses. See docs/research/O1_TRADING_API_COMPATIBILITY.md §5.
// ---------------------------------------------------------------------------

export const O1_HOST_V1 = 'api.o1.exchange';
export const O1_ORDER_PATH_V1 = '/api/v2/order';
export const BASE_CHAIN_ID_V1 = 8453;

/** The fixed 65-byte placeholder the official sample substitutes the Permit2
 * signature into. Recorded so the gate can find it — never so anything can
 * perform the substitution. */
export const O1_SIGNATURE_PLACEHOLDER_V1 =
  '42f68902113a2a579bcc207c91254c8516d921250e748c18a082d91d74908f8e9a05f27b72a030c6a42d77d0e0aab6fb09219b01a01e7b5b24e4f322ee1762ff1b';

const HexString = z.string().regex(/^0x[0-9a-fA-F]*$/, 'expected canonical 0x hex');
const HexQuantity = z.string().regex(/^0x[0-9a-fA-F]+$/, 'expected an integer hex quantity');
const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 20-byte address');

export const O1TradingOrderRequestV1Schema = z
  .object({
    schemaVersion: z.literal('o1-trading-order-request/v1'),
    networkId: z.number().int().positive(),
    signerAddress: Address,
    tokenAddress: Address,
    uiAmount: z.string().min(1),
    direction: z.enum(['buy', 'sell']),
    slippageBps: z.number().int().min(0).max(10_000),
    mevProtection: z.boolean(),
    quoteTokenAddress: Address.optional(),
    poolAddress: Address.optional(),
  })
  .strict();
export type O1TradingOrderRequestV1 = z.infer<typeof O1TradingOrderRequestV1Schema>;

export const O1Permit2RequestV1Schema = z
  .object({
    eip712: z
      .object({
        domain: z.record(z.unknown()),
        types: z.record(z.unknown()),
        values: z.record(z.unknown()),
      })
      .strict(),
  })
  .strict();
export type O1Permit2RequestV1 = z.infer<typeof O1Permit2RequestV1Schema>;

export const O1UnsignedTransactionV1Schema = z
  .object({
    to: Address,
    data: HexString,
    value: HexQuantity,
    gasLimit: HexQuantity,
    chainId: z.number().int().positive(),
  })
  .strict();
export type O1UnsignedTransactionV1 = z.infer<typeof O1UnsignedTransactionV1Schema>;

export const O1TradingOrderResponseV1Schema = z
  .object({
    success: z.boolean(),
    id: z.string().min(1),
    transactions: z
      .array(
        z
          .object({
            id: z.string().min(1),
            unsigned: O1UnsignedTransactionV1Schema,
            permit2: O1Permit2RequestV1Schema.optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type O1TradingOrderResponseV1 = z.infer<typeof O1TradingOrderResponseV1Schema>;

// --- findings --------------------------------------------------------------

export const O1_FINDING_CATEGORIES_V1 = [
  'authentication',
  'custody',
  'wallet_signing',
  'transaction_format',
  'permit2',
  'allowance',
  'atomicity',
  'simulation',
  'calldata_validation',
  'builder_attribution',
  'b20_controls',
  'quote_evidence',
  'freshness',
  'submission',
  'recovery',
  'route_proof',
] as const;
export type O1FindingCategoryV1 = (typeof O1_FINDING_CATEGORIES_V1)[number];

/** `blocker` is reserved for a requirement that cannot be satisfied without
 * abandoning the single execution path. It is not "serious" — it is
 * "no configuration makes this work". */
export const O1_FINDING_SEVERITIES_V1 = ['blocker', 'major', 'minor', 'info'] as const;
export type O1FindingSeverityV1 = (typeof O1_FINDING_SEVERITIES_V1)[number];

export const O1_FINDING_STATUSES_V1 = [
  'compatible',
  'conditionally_compatible',
  'incompatible',
  'unknown',
] as const;
export type O1FindingStatusV1 = (typeof O1_FINDING_STATUSES_V1)[number];

export const O1CompatibilityFindingV1Schema = z
  .object({
    id: z.string().regex(/^[a-z0-9_]+$/),
    category: z.enum(O1_FINDING_CATEGORIES_V1),
    status: z.enum(O1_FINDING_STATUSES_V1),
    severity: z.enum(O1_FINDING_SEVERITIES_V1),
    /** What was observed. Quoted from the spec, the sample, or the response —
     * never a paraphrase, because the paraphrase is what drifts. */
    evidence: z.string().min(1),
    /** Why the observation produces this status. */
    reason: z.string().min(1),
    /** What would have to change for the status to improve. `null` when no
     * change on Miorail's side could — the requirement is the provider's. */
    requiredChange: z.string().min(1).nullable(),
  })
  .strict();
export type O1CompatibilityFindingV1 = z.infer<typeof O1CompatibilityFindingV1Schema>;

export const O1_COMPATIBILITY_VERDICTS_V1 = [
  'compatible',
  'conditionally_compatible',
  'incompatible',
  'unknown',
] as const;
export type O1CompatibilityVerdictV1 = (typeof O1_COMPATIBILITY_VERDICTS_V1)[number];

export const O1CompatibilityReportV1Schema = z
  .object({
    schemaVersion: z.literal('o1-compatibility-report/v1'),
    /** Bumping this invalidates comparisons with older reports on purpose:
     * a report is a statement under a fixed set of checks. */
    gateVersion: z.literal('o1-compat/v1'),
    /** `fixtures` or `live` — a live report describes one response at one
     * moment and must not be presented as the spec's verdict. */
    source: z.enum(['fixtures', 'live']),
    /** Identity of what was judged, so the report is reproducible. */
    subjectHash: z.string().regex(/^0x[0-9a-f]{64}$/),
    checkedAt: z.string().datetime(),
    verdict: z.enum(O1_COMPATIBILITY_VERDICTS_V1),
    /** Every blocker, listed. A verdict without them would be an opinion. */
    blockers: z.array(z.string()),
    findings: z.array(O1CompatibilityFindingV1Schema).min(1),
    reportHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  })
  .strict();
export type O1CompatibilityReportV1 = z.infer<typeof O1CompatibilityReportV1Schema>;
