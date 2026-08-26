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

/** WHICH spelling of the official asset was worn. Recorded, never ranked —
 * see the migration for why the three are not the same finding. */
export const LOOKALIKE_ALIAS_KINDS_V1 = ['published_ticker', 'underlying', 'display_name'] as const;
export type LookalikeAliasKindV1 = (typeof LOOKALIKE_ALIAS_KINDS_V1)[number];

export const OfficialLookalikeRowV1Schema = z
  .object({
    chainId: z.literal(8453),
    tokenAddress: Address,
    officialAddress: Address,
    matchKind: z.enum(LOOKALIKE_MATCH_KINDS_V1),
    matchedAlias: z.enum(LOOKALIKE_ALIAS_KINDS_V1),
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
 * TWO SETS, AND THEY ARE NOT THE SAME SET.
 *
 * `officialAddresses` is the alias corpus: the assets a row may POINT AT,
 * because a reviewed source published a name for them. `reviewedAddresses` is
 * every address a reviewed root vouches for, and it is the set that may never
 * BE a lookalike. The second is a superset of the first, and the gap between
 * them is real:
 *
 *   Dinari's Base dShare declares `symbol() = "AAPL"`, exactly. Its issuer's
 *   own factory vouches for the address. But no reviewed source says which
 *   security it stands for — Dinari's own guide says the ticker is a display
 *   field — so it cannot be an alias target. It can only be excluded.
 *
 * Collapsing the two would force a choice between accusing a reviewed
 * contract of impersonation and inventing an underlying identity for it. Both
 * are wrong; the split is what makes neither necessary.
 *
 * Both sets are passed in with the write, AS THE CALLER SEES THEM. That is
 * deliberate: a store that looked them up itself would check a different list
 * from the one the matcher used, and the disagreement would surface as a
 * reviewed asset accused of impersonating itself.
 */
export function assertLookalikeIdentityV1(
  row: OfficialLookalikeRowV1,
  officialAddresses: ReadonlySet<string>,
  reviewedAddresses: ReadonlySet<string> = officialAddresses,
): void {
  if (officialAddresses.has(row.tokenAddress)) {
    throw new OfficialLookalikeIdentityError(
      row.tokenAddress,
      'it is itself an official contract, and an official contract is never an impostor',
    );
  }
  if (reviewedAddresses.has(row.tokenAddress)) {
    throw new OfficialLookalikeIdentityError(
      row.tokenAddress,
      "it is a reviewed representation of a named issuer, and an issuer's own contract is never an impostor",
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
  /**
   * Contracts REMOVED because a reviewed root now vouches for them.
   *
   * A resemblance is withdrawn, not annotated. Once an issuer's own factory
   * answers for an address, the sentence "this contract is not the official
   * one and is dressed as if it were" is simply false about it, and leaving a
   * row behind with a caveat would keep the accusation on the page.
   *
   * Withdrawal is a transition and is reported as one, because the day a
   * legitimate contract stops being listed as an impostor is a fact worth
   * seeing in the log rather than a silently shorter list.
   */
  withdrawn: string[];
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
    /** The alias corpus the matcher ran against: what a row may point at. */
    officialAddresses: readonly string[];
    /**
     * Every address a reviewed root vouches for: what may never be a row.
     *
     * Optional, and defaulting to the alias corpus, so a caller that has no
     * issuer registry yet behaves exactly as before. When it is supplied, any
     * existing row for one of these addresses is DELETED by the write — that
     * is how a newly reviewed representation leaves this list without anybody
     * having to remember to clean up after the registry.
     */
    reviewedAddresses?: readonly string[];
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

  /**
   * Newest first, bounded, optionally one spelling.
   *
   * `matchedAlias` is a SERVER filter for the same reason Discover's standing
   * filter is: 95 of the 112 contracts on file wear the underlying word rather
   * than the published ticker, so a client narrowing one page of 25 would
   * almost always narrow it to a page of the same thing.
   */
  recentLookalikes(input: {
    chainId: number;
    matchedAlias?: LookalikeAliasKindV1;
    limit: number;
  }): Promise<OfficialLookalikeRowV1[]>;

  /**
   * How many contracts wear each spelling.
   *
   * Counted over the whole table rather than the returned page, because the
   * number beside a filter is a claim about the corpus. Every alias kind is
   * present in the result even at zero -- a filter that vanishes when it is
   * empty reads as a filter that does not exist.
   */
  lookalikeCounts(input: { chainId: number }): Promise<{
    total: number;
    byAlias: Record<LookalikeAliasKindV1, number>;
    /** The newest reading in the table -- when the corpus was last scanned.
     * Null before the first scan, which is not the same as a scan that found
     * nothing. */
    lastSeenAt: string | null;
  }>;

  /** How many contracts wear each official asset's name, keyed by the official
   * address. One query rather than one per card. */
  lookalikeCountsByOfficial(input: { chainId: number }): Promise<Record<string, number>>;
}

/** Zero for every spelling. The starting point for both counts, so neither
 * implementation can omit a kind by forgetting it. */
export function emptyLookalikeCountsV1(): Record<LookalikeAliasKindV1, number> {
  return { published_ticker: 0, underlying: 0, display_name: 0 };
}
