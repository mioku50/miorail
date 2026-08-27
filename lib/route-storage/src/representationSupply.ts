import { z } from 'zod';

import { RouteStorageIntegrityError } from './types.js';

const Address = z.string().regex(/^0x[0-9a-f]{40}$/, 'expected a lowercase 20-byte address');
const Digits = z.string().regex(/^(0|[1-9][0-9]*)$/);
const Hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const Timestamp = z.string().datetime();

export const REPRESENTATION_SUPPLY_STATES_V1 = [
  'positive_supply',
  'zero_supply',
  'supply_unknown',
] as const;
export type RepresentationSupplyStateV1 = (typeof REPRESENTATION_SUPPLY_STATES_V1)[number];

export const REPRESENTATION_SUPPLY_READ_OUTCOMES_V1 = [
  'success',
  'rpc_failure',
  'decode_failure',
] as const;
export type RepresentationSupplyReadOutcomeV1 =
  (typeof REPRESENTATION_SUPPLY_READ_OUTCOMES_V1)[number];

const SupplyFactV1Schema = z
  .object({
    chainId: z.literal(8453),
    tokenAddress: Address,
    state: z.enum(REPRESENTATION_SUPPLY_STATES_V1),
    totalSupplyAtomic: Digits.nullable(),
    decimals: z.number().int().min(0).max(36).nullable(),
    normalization: z.literal('raw_erc20_total_supply'),
    blockNumber: Digits,
    blockHash: Hash,
    source: z.literal('erc20_total_supply'),
    evidenceHash: Hash,
    readOutcome: z.enum(REPRESENTATION_SUPPLY_READ_OUTCOMES_V1),
    failureCode: z.string().min(1).max(120).nullable(),
    observedAt: Timestamp,
  })
  .strict();

function refineSupplyFactV1(row: z.infer<typeof SupplyFactV1Schema>, ctx: z.RefinementCtx): void {
  const successful = row.readOutcome === 'success';
  if (successful !== (row.totalSupplyAtomic !== null && row.decimals !== null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'only a successful totalSupply/decimals read carries an amount',
    });
  }
  if (successful !== (row.failureCode === null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'a failed supply read carries a failure code and a successful read does not',
    });
  }
  const expected: RepresentationSupplyStateV1 =
    row.totalSupplyAtomic === null
      ? 'supply_unknown'
      : row.totalSupplyAtomic === '0'
        ? 'zero_supply'
        : 'positive_supply';
  if (row.state !== expected) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['state'],
      message: `the observed amount/read outcome requires ${expected}`,
    });
  }
}

export const RepresentationSupplyObservationV1Schema = SupplyFactV1Schema.extend({
  recordedAt: Timestamp,
}).superRefine((row, ctx) => {
  refineSupplyFactV1(row, ctx);
  if (Date.parse(row.recordedAt) < Date.parse(row.observedAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'a supply observation cannot be recorded before it was observed',
    });
  }
});
export type RepresentationSupplyObservationV1 = z.infer<
  typeof RepresentationSupplyObservationV1Schema
>;

export const RepresentationSupplyRowV1Schema = SupplyFactV1Schema.extend({
  lastCheckedAt: Timestamp,
  lastChangedAt: Timestamp.nullable(),
  reads: z.number().int().min(1),
  changes: z.number().int().min(0),
  createdAt: Timestamp,
}).superRefine((row, ctx) => {
  refineSupplyFactV1(row, ctx);
  if ((row.changes === 0) !== (row.lastChangedAt === null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'a supply change count with no time behind it is a count of nothing',
    });
  }
  if (row.changes >= row.reads) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'the first successful supply observation is a baseline, not a change',
    });
  }
});
export type RepresentationSupplyRowV1 = z.infer<typeof RepresentationSupplyRowV1Schema>;

export const RepresentationSupplyChangeV1Schema = z
  .object({
    chainId: z.literal(8453),
    tokenAddress: Address,
    fromTotalSupplyAtomic: Digits,
    toTotalSupplyAtomic: Digits,
    decimals: z.number().int().min(0).max(36),
    blockNumber: Digits,
    blockHash: Hash,
    evidenceHash: Hash,
    observedAt: Timestamp,
    recordedAt: Timestamp,
  })
  .strict()
  .superRefine((row, ctx) => {
    if (row.fromTotalSupplyAtomic === row.toTotalSupplyAtomic) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'an unchanged supply is not a transition',
      });
    }
    if (Date.parse(row.recordedAt) < Date.parse(row.observedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a supply transition cannot be recorded before it was observed',
      });
    }
  });
export type RepresentationSupplyChangeV1 = z.infer<typeof RepresentationSupplyChangeV1Schema>;

function integrityV1<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new RouteStorageIntegrityError(`${label} failed validation: ${detail}`);
}

export const assertRepresentationSupplyObservationV1 = (value: unknown) =>
  integrityV1(RepresentationSupplyObservationV1Schema, value, 'representation supply observation');
export const assertRepresentationSupplyV1 = (value: unknown) =>
  integrityV1(RepresentationSupplyRowV1Schema, value, 'representation supply');
export const assertRepresentationSupplyChangeV1 = (value: unknown) =>
  integrityV1(RepresentationSupplyChangeV1Schema, value, 'representation supply change');

export type SupplyRecordOutcomeV1 = 'first_observation' | 'unchanged' | 'changed' | 'unresolved';

export interface RepresentationSupplyRepositoryV1 {
  recordObservation(input: {
    chainId: number;
    tokenAddress: string;
    totalSupplyAtomic: string | null;
    decimals: number | null;
    blockNumber: string;
    blockHash: string;
    evidenceHash: string;
    readOutcome: RepresentationSupplyReadOutcomeV1;
    failureCode: string | null;
    observedAt: string;
    now: string;
  }): Promise<{ outcome: SupplyRecordOutcomeV1; row: RepresentationSupplyRowV1 }>;

  readSupplies(input: {
    chainId: number;
    tokenAddresses: readonly string[];
  }): Promise<RepresentationSupplyRowV1[]>;

  recentChanges(input: { chainId: number; limit: number }): Promise<RepresentationSupplyChangeV1[]>;

  recentObservations(input: {
    chainId: number;
    tokenAddress: string;
    limit: number;
  }): Promise<RepresentationSupplyObservationV1[]>;
}

export function supplyStateForAmountV1(
  totalSupplyAtomic: string | null,
): RepresentationSupplyStateV1 {
  return totalSupplyAtomic === null
    ? 'supply_unknown'
    : totalSupplyAtomic === '0'
      ? 'zero_supply'
      : 'positive_supply';
}
