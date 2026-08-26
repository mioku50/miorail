import { z } from 'zod';

import { RouteStorageIntegrityError } from './types.js';

// ---------------------------------------------------------------------------
// The ratio between one token and one underlying share.
//
// Base Docs open the tokenized-stocks page with a warning: "One B20 token does
// not permanently equal one share." Every Coinbase representation reads exactly
// 1e18 today, which is the reason to store it rather than assume it — a value
// that is 1.0 everywhere is indistinguishable from a value nobody reads, right
// up until the day it moves.
//
// This is deliberately NOT a B20 table. Three issuers have representations on
// Base and they do three different things, so the discriminator that matters
// is not who issued the token but WHO APPLIES THE RATIO:
//
//   * `apply_to_raw_balance`      — B20. `balanceOf` is raw; the caller does
//                                   `raw * multiplier / scale`.
//   * `already_applied_by_token`  — a rebasing token. `balanceOf` has already
//                                   applied it, and applying it again
//                                   double-counts every corporate action.
//
// One column, and it is the whole difference between two issuers' conventions.
// A new issuer arrives as a new `ratioKind`, not a new table.
// ---------------------------------------------------------------------------

const Address = z.string().regex(/^0x[0-9a-f]{40}$/, 'expected a lowercase 20-byte address');
const Digits = z.string().regex(/^(0|[1-9][0-9]*)$/);
const PositiveDigits = z.string().regex(/^[1-9][0-9]*$/);
const Hash = z.string().regex(/^0x[0-9a-f]{64}$/);

/** The reviewed adapters. Adding one is a review decision: it means somebody
 * proved which function to call AND which side applies the result. */
export const RATIO_KINDS_V1 = ['b20_multiplier', 'dinari_balance_per_share'] as const;
export type RatioKindV1 = (typeof RATIO_KINDS_V1)[number];

export const RATIO_APPLICATIONS_V1 = ['apply_to_raw_balance', 'already_applied_by_token'] as const;
export type RatioApplicationV1 = (typeof RATIO_APPLICATIONS_V1)[number];

/** How each reviewed adapter's value must be used. Single-sourced so a reader
 * and a writer cannot disagree about who already applied it. */
export const RATIO_APPLICATION_BY_KIND_V1: Readonly<Record<RatioKindV1, RatioApplicationV1>> = {
  // IB20Asset: "Holder balances are stored [raw]"; `toScaledBalance(raw) =
  // raw * multiplier / WAD_PRECISION`.
  b20_multiplier: 'apply_to_raw_balance',
  // DShare extends ERC20Rebasing: `balanceOf` already divides by
  // balance-per-share. Applying it again double-counts every split.
  dinari_balance_per_share: 'already_applied_by_token',
};

/**
 * WHERE the scale came from, which is not the same as what it is.
 *
 * A B20 publishes its own scale — `WAD_PRECISION()` — so the reader READS it,
 * and a deployment that ever changed it would be followed rather than
 * misread. A dShare does not publish one: the divisor is a constant in the
 * issuer's own source ("This amount is assumed to have 18 decimals and is
 * divided by 10**18 when applied" — ERC20Rebasing.sol), so a reviewed adapter
 * DECLARES it.
 *
 * Both end up as the same digits in `scale`. The difference is whether the
 * chain told us or a person did, and a surface that cannot see the difference
 * will eventually claim we measured something we were told.
 */
export const RATIO_SCALE_SOURCES_V1 = ['read_from_contract', 'reviewed_constant'] as const;
export type RatioScaleSourceV1 = (typeof RATIO_SCALE_SOURCES_V1)[number];

export const RATIO_SCALE_SOURCE_BY_KIND_V1: Readonly<Record<RatioKindV1, RatioScaleSourceV1>> = {
  b20_multiplier: 'read_from_contract',
  dinari_balance_per_share: 'reviewed_constant',
};

/** The scale a reviewed adapter declares, for the kinds whose contracts do not
 * publish one. Null where the scale is read instead of declared, so a caller
 * cannot quietly substitute a constant for a missing read. */
export const RATIO_DECLARED_SCALE_BY_KIND_V1: Readonly<Record<RatioKindV1, string | null>> = {
  b20_multiplier: null,
  dinari_balance_per_share: '1000000000000000000',
};

export const RepresentationRatioRowV1Schema = z
  .object({
    chainId: z.literal(8453),
    tokenAddress: Address,
    ratioKind: z.enum(RATIO_KINDS_V1),
    application: z.enum(RATIO_APPLICATIONS_V1),
    rawValue: PositiveDigits,
    scale: PositiveDigits,
    scaleSource: z.enum(RATIO_SCALE_SOURCES_V1),
    blockNumber: Digits,
    blockHash: Hash,
    evidenceHash: Hash,
    observedAt: z.string().datetime(),
    lastCheckedAt: z.string().datetime(),
    lastChangedAt: z.string().datetime().nullable(),
    reads: z.number().int().min(1),
    changes: z.number().int().min(0),
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((row, ctx) => {
    if (RATIO_APPLICATION_BY_KIND_V1[row.ratioKind] !== row.application) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['application'],
        message: `a ${row.ratioKind} ratio is applied by ${RATIO_APPLICATION_BY_KIND_V1[row.ratioKind]}`,
      });
    }
    if (RATIO_SCALE_SOURCE_BY_KIND_V1[row.ratioKind] !== row.scaleSource) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scaleSource'],
        message: `a ${row.ratioKind} scale comes from ${RATIO_SCALE_SOURCE_BY_KIND_V1[row.ratioKind]}`,
      });
    }
    const declared = RATIO_DECLARED_SCALE_BY_KIND_V1[row.ratioKind];
    if (declared !== null && row.scale !== declared) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scale'],
        message: `a ${row.ratioKind} scale is the reviewed constant ${declared}, and this row carries ${row.scale}`,
      });
    }
    if ((row.changes === 0) !== (row.lastChangedAt === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a change count with no time behind it is a count of nothing',
      });
    }
    if (row.changes > 0 && row.changes >= row.reads) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'the first read of a representation is never a change, so changes stay below reads',
      });
    }
  });
export type RepresentationRatioRowV1 = z.infer<typeof RepresentationRatioRowV1Schema>;

export const RepresentationRatioChangeV1Schema = z
  .object({
    chainId: z.literal(8453),
    tokenAddress: Address,
    ratioKind: z.enum(RATIO_KINDS_V1),
    fromRawValue: PositiveDigits,
    toRawValue: PositiveDigits,
    scale: PositiveDigits,
    blockNumber: Digits,
    blockHash: Hash,
    evidenceHash: Hash,
    observedAt: z.string().datetime(),
    recordedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((row, ctx) => {
    if (row.fromRawValue === row.toRawValue) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a value that did not move is not a change',
      });
    }
    if (Date.parse(row.recordedAt) < Date.parse(row.observedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a change cannot be recorded before it was observed',
      });
    }
  });
export type RepresentationRatioChangeV1 = z.infer<typeof RepresentationRatioChangeV1Schema>;

export function assertRepresentationRatioV1(
  value: unknown,
  direction: 'read' | 'write' = 'read',
): RepresentationRatioRowV1 {
  const parsed = RepresentationRatioRowV1Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  throw new RouteStorageIntegrityError(`representation ratio failed validation on ${direction}: ${detail}`);
}

export function assertRepresentationRatioChangeV1(
  value: unknown,
  direction: 'read' | 'write' = 'read',
): RepresentationRatioChangeV1 {
  const parsed = RepresentationRatioChangeV1Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  throw new RouteStorageIntegrityError(
    `representation ratio change failed validation on ${direction}: ${detail}`,
  );
}

/** What one reading did to what was stored. `first_observation` exists so a
 * caller can tell "we had never looked" from "it has not moved" — the first
 * pass of any writer reports nothing, exactly as the signal emitters do. */
export type RatioReadOutcomeV1 = 'first_observation' | 'unchanged' | 'changed';

export interface RepresentationRatioRepositoryV1 {
  /**
   * Record one successful read.
   *
   * A transition is written only when the stored value differs from the one
   * observed, so the first sighting of a representation announces nothing.
   * Re-reading the same block is idempotent: it must not produce a second
   * transition, and the storage-level uniqueness on (representation, block) is
   * what enforces that rather than a check the caller could forget.
   */
  recordRead(input: {
    chainId: number;
    tokenAddress: string;
    ratioKind: RatioKindV1;
    rawValue: string;
    scale: string;
    blockNumber: string;
    blockHash: string;
    evidenceHash: string;
    observedAt: string;
    now: string;
  }): Promise<{ outcome: RatioReadOutcomeV1; row: RepresentationRatioRowV1 }>;

  /** The stored ratios for a set of representations. An address with no row
   * has not been read; that is never rendered as 1.0. */
  readRatios(input: {
    chainId: number;
    tokenAddresses: readonly string[];
  }): Promise<RepresentationRatioRowV1[]>;

  /** Transitions, newest first. The only place a corporate action shows up,
   * because the tokens publish no advance notice this build can call. */
  recentChanges(input: { chainId: number; limit: number }): Promise<RepresentationRatioChangeV1[]>;
}
