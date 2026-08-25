import { z } from 'zod';

const Address = z.string().regex(/^0x[0-9a-f]{40}$/);
const Hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const Digits = z.string().regex(/^(0|[1-9][0-9]*)$/);
const SignedDigits = z.string().regex(/^-?(0|[1-9][0-9]*)$/);
const Timestamp = z.string().datetime();

export const CashExitStateV1Schema = z.enum([
  'full',
  'partial',
  'buy_only',
  'unavailable',
  'not_measured',
  'measurement_failed',
]);
export type CashExitStateV1 = z.infer<typeof CashExitStateV1Schema>;

export const CashExitQuoteEvidenceRefV1Schema = z
  .object({
    kind: z.literal('router_quote'),
    source: z.string().min(1).max(100),
    direction: z.enum(['buy', 'sell']),
    routeKey: z.string().min(1).max(300),
    candidateHash: Hash,
    evidenceHash: Hash,
    observedAt: Timestamp,
    expiresAt: Timestamp,
    blockNumber: Digits.nullable(),
  })
  .strict();

export const CashExitSimulationEvidenceV1Schema = z
  .object({
    status: z.enum(['not_simulated', 'passed', 'failed', 'unavailable']),
    kind: z.literal('route_simulation'),
    candidateHash: Hash.nullable(),
    evidenceHash: Hash.nullable(),
    observedAt: Timestamp.nullable(),
    blockNumber: Digits.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.status === 'not_simulated' &&
      [value.candidateHash, value.evidenceHash, value.observedAt, value.blockNumber].some(
        (item) => item !== null,
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'an unrun simulation carries no evidence',
      });
    }
  });

export const CashExitSourceProjectionV1Schema = z
  .object({
    source: z.string().min(1).max(100),
    status: z.enum(['full', 'buy_only', 'unavailable', 'measurement_failed', 'not_measured']),
    errorCode: z.string().min(1).max(120).nullable(),
    observedAt: Timestamp.nullable(),
    expiresAt: Timestamp.nullable(),
    buyEvidenceHash: Hash.nullable(),
    sellEvidenceHash: Hash.nullable(),
  })
  .strict();

export const CashExitLadderRungV1Schema = z
  .object({
    sizeKind: z.enum(['cash_equivalent', 'actual_position']),
    requestedCashAtomic: Digits.nullable(),
    requestedTokenAtomic: Digits.nullable(),
    tokenDecimals: z.number().int().min(6).max(18),
    destination: z.enum(['USDC', 'ETH']),
    destinationAddress: Address,
    destinationDecimals: z.union([z.literal(6), z.literal(18)]),
    status: CashExitStateV1Schema,
    exactTestedTokenAtomic: Digits.nullable(),
    exactExecutableTokenAtomic: Digits.nullable(),
    returnedAtomic: Digits.nullable(),
    roundTripCostBps: SignedDigits.nullable(),
    lowerBoundRequestedCashAtomic: Digits.nullable(),
    derivedFromExactRung: z.boolean(),
    interpolated: z.literal(false),
    evidenceStrength: z.literal('router_quote'),
    executionProven: z.literal(false),
    approvedSources: z.array(z.string().min(1).max(100)).min(1).max(16),
    sources: z.array(CashExitSourceProjectionV1Schema).min(1).max(16),
    quoteEvidence: z.array(CashExitQuoteEvidenceRefV1Schema).max(32),
    simulationEvidence: CashExitSimulationEvidenceV1Schema,
    observedAt: Timestamp.nullable(),
    expiresAt: Timestamp.nullable(),
  })
  .strict();
export type CashExitLadderRungV1 = z.infer<typeof CashExitLadderRungV1Schema>;

export const CashExitLadderV1Schema = z
  .object({
    status: z.enum(['measured', 'not_measured']),
    semantics: z.literal('asset_level_approved_router_quotes'),
    directPoolMeasurementsAreDiagnosticOnly: z.literal(true),
    exactSizesOnly: z.literal(true),
    defaultCashSizesAtomic: z.array(Digits).length(4),
    approvedSources: z.array(z.string().min(1).max(100)).max(16),
    publicRunId: Hash.nullable(),
    positionRunId: Hash.nullable(),
    rungs: z.array(CashExitLadderRungV1Schema).max(32),
  })
  .strict();
export type CashExitLadderV1 = z.infer<typeof CashExitLadderV1Schema>;
