import { z } from 'zod';

import { RouteStorageIntegrityError } from './types.js';

// ---------------------------------------------------------------------------
// Contracts dressed as an official asset.
//
// Two invariants, both enforced here rather than trusted to a caller, because
// each one is a way this feature could accuse the wrong contract:
//
//   1. An OFFICIAL contract can never be stored as a lookalike. The corpus is
//      passed in with the write and checked against, so the store does not
//      have to trust that whoever ran the matcher used the same list.
//   2. A lookalike must point at an address that IS in that corpus. A row
//      naming an "official" asset the corpus does not contain is a stale or
//      invented reference, and it would render as a comparison against
//      nothing.
//
// Nothing here carries a severity, a score or a verdict. A resemblance is a
// resemblance; why somebody chose a name is not on chain.
// ---------------------------------------------------------------------------

const Address = z.string().regex(/^0x[0-9a-f]{40}$/, 'expected a lowercase 20-byte address');

export const LOOKALIKE_MATCH_KINDS_V1 = ['symbol_exact', 'symbol_normalized', 'name_normalized'] as const;
export type LookalikeMatchKindV1 = (typeof LOOKALIKE_MATCH_KINDS_V1)[number];

export const OfficialLookalikeRowV1Schema = z
  .object({
    chainId: z.literal(8453),
    tokenAddress: Address,
    officialAddress: Address,
    matchKind: z.enum(LOOKALIKE_MATCH_KINDS_V1),
    /** The normalized string both sides shared, so a reader can see why. */
    matchedValue: z.string().min(1).max(120),
    /** What the contract declared when it was flagged. Copied rather than
     * joined: B20 metadata is mutable, and a row that pointed at the index
     * would rewrite its own evidence when the impostor renamed itself. */
    launchSymbol: z.string().max(120),
    launchName: z.string().max(200),
    /** Null when the index does not know — different from a launch at zero. */
    launchedAt: z.string().datetime().nullable(),
    firstFlaggedAt: z.string().datetime(),
    lastSeenAt: z.string().datetime(),
  })
  .strict()
  .superRefine((row, ctx) => {
    if (row.tokenAddress === row.officialAddress) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'an official contract cannot be a lookalike of itself',
      });
    }
    if (Date.parse(row.lastSeenAt) < Date.parse(row.firstFlaggedAt)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'last seen precedes first flagged' });
    }
  });

export type OfficialLookalikeRowV1 = z.infer<typeof OfficialLookalikeRowV1Schema>;

export function assertOfficialLookalikeV1(
  value: unknown,
  direction: 'read' | 'write' = 'read',
): OfficialLookalikeRowV1 {
  const parsed = OfficialLookalikeRowV1Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw new RouteStorageIntegrityError(`official lookalike failed validation on ${direction}: ${detail}`);
}

/** The refusal raised when a row would accuse an official contract, or point
 * at one the corpus does not contain. A distinct type so a caller cannot
 * mistake it for a transport failure and retry it. */
export class OfficialLookalikeIdentityError extends RouteStorageIntegrityError {
  constructor(tokenAddress: string, reason: string) {
    super(`refusing a lookalike row for ${tokenAddress}: ${reason}`);
    this.name = 'OfficialLookalikeIdentityError';
  }
}

/**
 * The identity check both repositories run, written once.
 *
 * `officialAddresses` is the corpus AS THE CALLER SEES IT, passed in with the
 * write. That is deliberate: a store that looked the corpus up itself would
 * check a different list from the one the matcher used, and the disagreement
 * would surface as an official asset accused of impersonating itself.
 */
export function assertLookalikeIdentityV1(
  row: OfficialLookalikeRowV1,
  officialAddresses: ReadonlySet<string>,
): void {
  if (officialAddresses.has(row.tokenAddress)) {
    throw new OfficialLookalikeIdentityError(
      row.tokenAddress,
      'it is itself an official contract, and an official contract is never an impostor',
    );
  }
  if (!officialAddresses.has(row.officialAddress)) {
    throw new OfficialLookalikeIdentityError(
      row.tokenAddress,
      `it names ${row.officialAddress} as official, and the corpus does not contain that address`,
    );
  }
}

export interface OfficialLookalikeOutcomeV1 {
  /** Contracts flagged for the first time — the input to a Signal. */
  flagged: string[];
  /** Contracts already flagged, whose reading was refreshed. */
  refreshed: string[];
}

export interface OfficialLookalikeRepositoryV1 {
  /**
   * One scan's findings, written as a unit.
   *
   * `firstFlaggedAt` is preserved for a contract already known: when it started
   * wearing the name is a fact a later scan must not reset.
   */
  recordLookalikes(input: {
    chainId: number;
    /** The official corpus the matcher ran against. */
    officialAddresses: readonly string[];
    rows: readonly OfficialLookalikeRowV1[];
  }): Promise<OfficialLookalikeOutcomeV1>;

  /** What one official asset's card shows: contracts wearing its name. */
  lookalikesOf(input: {
    chainId: number;
    officialAddress: string;
    limit: number;
  }): Promise<OfficialLookalikeRowV1[]>;

  /** What Investigate shows for a pasted address. Null is the ordinary answer
   * and means only that nothing matched — never that the contract was checked
   * and found honest. */
  lookalikeFor(input: { chainId: number; tokenAddress: string }): Promise<OfficialLookalikeRowV1 | null>;

  /** Newest first, bounded. The Signals feed. */
  recentLookalikes(input: { chainId: number; limit: number }): Promise<OfficialLookalikeRowV1[]>;
}
