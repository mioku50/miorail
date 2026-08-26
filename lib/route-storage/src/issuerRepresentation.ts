import { z } from 'zod';

import { RouteStorageIntegrityError } from './types.js';

// ---------------------------------------------------------------------------
// Which issuer deployed this exact address — and nothing else.
//
// Phase 9A.5 established that Dinari's own factory on Base answers
// `isTokenDShare(address)`, a public membership predicate on a contract the
// issuer deployed. A `true` from it is real evidence, and it is evidence about
// ONE thing: who issued that address.
//
// It is not evidence about which security the address stands for. The token
// declares `symbol() = "AAPL"` and Dinari's own guide says the opposite of
// what that invites — key off `stock_id`, treat `symbol` as a display field —
// and `setSymbol` is an admin call on the deployed contract. So the underlying
// is a separate axis with a separate source, and it is not in this file.
//
// THREE RULES, ENFORCED RATHER THAN REMEMBERED
//
//   1. A row names the ROOT it came from. Two Dinari factories are live on
//      Base and they disagree about the same token, because one is production
//      and one is staging. Membership under one is not membership under the
//      other, and the primary key says so.
//   2. `refuted` is an answer; a failed read is not. There is no third value
//      in the column, because a read that did not complete writes no row at
//      all. An address with no row was never asked.
//   3. The first sighting is never a change. Same rule as the ratio store: a
//      cold start that announced fifty issuer changes would be reporting our
//      own first pass as the issuer's activity.
// ---------------------------------------------------------------------------

const Address = z.string().regex(/^0x[0-9a-f]{40}$/, 'expected a lowercase 20-byte address');
const Digits = z.string().regex(/^(0|[1-9][0-9]*)$/);
const Hash = z.string().regex(/^0x[0-9a-f]{64}$/);

/** The reviewed issuers. Adding one is a review decision about a trust root,
 * not a config value. */
export const REPRESENTATION_ISSUERS_V1 = ['coinbase', 'dinari'] as const;
export type RepresentationIssuerV1 = (typeof REPRESENTATION_ISSUERS_V1)[number];

/** What the root said. There is no `unknown` here on purpose — see rule 2. */
export const MEMBERSHIP_STATES_V1 = ['established', 'refuted'] as const;
export type MembershipStateV1 = (typeof MEMBERSHIP_STATES_V1)[number];

/** How one pass of the root ended. The two failures are OURS. */
export const MEMBERSHIP_CHECK_STATUSES_V1 = ['ok', 'root_unreadable', 'endpoint_unavailable'] as const;
export type MembershipCheckStatusV1 = (typeof MEMBERSHIP_CHECK_STATUSES_V1)[number];

export const IssuerRepresentationRowV1Schema = z
  .object({
    chainId: z.literal(8453),
    tokenAddress: Address,
    issuerId: z.enum(REPRESENTATION_ISSUERS_V1),
    rootKey: z.string().min(1).max(120),
    rootAddress: Address,
    membership: z.enum(MEMBERSHIP_STATES_V1),
    blockNumber: Digits,
    blockHash: Hash,
    evidenceHash: Hash,
    firstSeenAt: z.string().datetime(),
    lastCheckedAt: z.string().datetime(),
    lastChangedAt: z.string().datetime().nullable(),
    reads: z.number().int().min(1),
    changes: z.number().int().min(0),
  })
  .strict()
  .superRefine((row, ctx) => {
    if ((row.changes === 0) !== (row.lastChangedAt === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a change count with no time behind it is a count of nothing',
      });
    }
    if (row.changes >= row.reads) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'the first read of a representation is never a change, so changes cannot reach reads',
      });
    }
    if (Date.parse(row.lastCheckedAt) < Date.parse(row.firstSeenAt)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'last checked precedes first seen' });
    }
  });

export type IssuerRepresentationRowV1 = z.infer<typeof IssuerRepresentationRowV1Schema>;

export const IssuerMembershipCheckV1Schema = z
  .object({
    issuerId: z.enum(REPRESENTATION_ISSUERS_V1),
    rootKey: z.string().min(1).max(120),
    chainId: z.literal(8453),
    rootAddress: Address,
    predicateSelector: z.string().regex(/^0x[0-9a-f]{8}$/),
    status: z.enum(MEMBERSHIP_CHECK_STATUSES_V1),
    blockNumber: Digits.nullable(),
    blockHash: Hash.nullable(),
    candidates: z.number().int().min(0),
    established: z.number().int().min(0),
    refuted: z.number().int().min(0),
    /** Ours: asked and not answered. Counted apart so an endpoint outage can
     * never be read as the root refusing an address. */
    unread: z.number().int().min(0),
    observedAt: z.string().datetime(),
    /** Why it did not complete, in our words. Never a URL, never a key. */
    detail: z.string().max(400).nullable(),
  })
  .strict()
  .superRefine((row, ctx) => {
    if (row.established + row.refuted + row.unread !== row.candidates) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'every candidate must land in exactly one of established, refuted or unread',
      });
    }
    if (row.status !== 'ok' && (row.established > 0 || row.refuted > 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `a ${row.status} check decided nothing about any address`,
      });
    }
    if ((row.status === 'ok') !== (row.blockNumber !== null && row.blockHash !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'an answer from the chain has a block behind it, and a failure has none',
      });
    }
  });

export type IssuerMembershipCheckV1 = z.infer<typeof IssuerMembershipCheckV1Schema>;

export interface IssuerMembershipCheckRecordV1 extends IssuerMembershipCheckV1 {
  checkId: string;
}

export type MembershipReadOutcomeV1 = 'first_observation' | 'unchanged' | 'changed';

export function assertIssuerRepresentationV1(
  value: unknown,
  direction: 'read' | 'write' = 'read',
): IssuerRepresentationRowV1 {
  const parsed = IssuerRepresentationRowV1Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw new RouteStorageIntegrityError(`issuer representation failed validation on ${direction}: ${detail}`);
}

export function assertIssuerMembershipCheckV1(
  value: unknown,
  direction: 'read' | 'write' = 'read',
): IssuerMembershipCheckV1 {
  const parsed = IssuerMembershipCheckV1Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw new RouteStorageIntegrityError(`issuer membership check failed validation on ${direction}: ${detail}`);
}

/** What one address's read carries in. */
export interface MembershipReadInputV1 {
  chainId: number;
  tokenAddress: string;
  issuerId: RepresentationIssuerV1;
  rootKey: string;
  rootAddress: string;
  membership: MembershipStateV1;
  blockNumber: string;
  blockHash: string;
  evidenceHash: string;
  observedAt: string;
}

export interface IssuerRepresentationRepositoryV1 {
  /**
   * One address, as one root answered about it.
   *
   * Returns the outcome as a transition, not as a state: `first_observation`
   * on the pass that created the row, `changed` only when the stored answer
   * actually moved. A caller reading `changed` is reading an event about the
   * issuer; a caller reading the row is reading the current claim.
   */
  recordMembership(
    input: MembershipReadInputV1,
  ): Promise<{ outcome: MembershipReadOutcomeV1; row: IssuerRepresentationRowV1 }>;

  /** One pass over a set of candidates, recorded whatever the outcome — so a
   * root we could not reach is stored as a failed check rather than as an
   * absence of activity. */
  recordCheck(input: IssuerMembershipCheckV1): Promise<IssuerMembershipCheckRecordV1>;

  /** The newest pass of one root, successful or not. Null before the first. */
  latestCheck(input: {
    issuerId: RepresentationIssuerV1;
    rootKey: string;
    successfulOnly?: boolean;
  }): Promise<IssuerMembershipCheckRecordV1 | null>;

  /**
   * What the reviewed roots say about these addresses.
   *
   * Bounded by the caller's list rather than by a page, because the only
   * question worth asking here is about addresses somebody already has.
   */
  membershipFor(input: {
    chainId: number;
    tokenAddresses: readonly string[];
  }): Promise<IssuerRepresentationRowV1[]>;

  /**
   * Every address one issuer's root has established, bounded.
   *
   * This is the set that must never appear in Lookalikes: a contract the
   * issuer itself vouches for is not wearing somebody's name, whatever it is
   * called.
   */
  establishedRepresentations(input: {
    chainId: number;
    issuerId?: RepresentationIssuerV1;
    limit: number;
  }): Promise<IssuerRepresentationRowV1[]>;
}
