import { z } from 'zod';

import { RouteStorageIntegrityError } from './types.js';

// ---------------------------------------------------------------------------
// Project claims and the evidence hanging off them.
//
// Two tables and one rule that spans them: an evidence row may not exist
// without a verified claim on the same token. The claim IS the permission to
// attach anything, so the storage layer refuses evidence for a token whose
// claim is missing, unverified or refuted — rather than trusting a caller to
// check, which is how a project's record ends up on a copycat's card.
//
// Written to the repository interface as an invariant so the in-memory fake and
// Postgres refuse the same writes. Three production bugs came from the two
// disagreeing.
// ---------------------------------------------------------------------------

const Address = z.string().regex(/^0x[0-9a-f]{40}$/, 'expected a lowercase 20-byte address');

/** A hostname, lowercase, no scheme and no path. What a claim is made FROM. */
const Domain = z
  .string()
  .min(3)
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, 'expected a bare lowercase domain');

export const B20_CLAIM_LINK_KEYS_V1 = ['launch_sender', 'domain_file', 'project_publication'] as const;
export const B20_CLAIM_STATUSES_V1 = ['unverified', 'verified', 'refuted'] as const;

export const B20ProjectClaimRowV1Schema = z
  .object({
    chainId: z.literal(8453),
    tokenAddress: Address,
    claimantDomain: Domain,
    status: z.enum(B20_CLAIM_STATUSES_V1),
    verifiedLinks: z.array(z.enum(B20_CLAIM_LINK_KEYS_V1)).max(3),
    refutedLinks: z.array(z.enum(B20_CLAIM_LINK_KEYS_V1)).max(3),
    lastCheckedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((row, ctx) => {
    // A verified claim with no verified link is a status nothing supports, and
    // it is the exact row that would open the gate on no evidence at all.
    if (row.status === 'verified' && row.verifiedLinks.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a verified claim must carry at least one verified link',
      });
    }
    if (row.status === 'refuted' && row.refutedLinks.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a refuted claim must name the link that refuted it',
      });
    }
    const overlap = row.verifiedLinks.filter((link) => row.refutedLinks.includes(link));
    if (overlap.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `a link cannot be both verified and refuted: ${overlap.join(', ')}`,
      });
    }
  });

export type B20ProjectClaimRowV1 = z.infer<typeof B20ProjectClaimRowV1Schema>;

export const B20_FUNDAMENTAL_DIMENSION_KEYS_V1 = [
  'project_identity',
  'website',
  'product',
  'repository',
  'base_presence',
  'docs',
  'project_before_token',
  'development_activity',
] as const;

export const B20_FUNDAMENTAL_STATE_KEYS_V1 = [
  'verified',
  'unverified',
  'live',
  'found',
  'active',
  'quiet',
  'yes',
  'no',
  'unknown',
] as const;

export type B20FundamentalDimensionKeyV1 = (typeof B20_FUNDAMENTAL_DIMENSION_KEYS_V1)[number];
export type B20FundamentalStateKeyV1 = (typeof B20_FUNDAMENTAL_STATE_KEYS_V1)[number];

export const B20_FUNDAMENTAL_PROVENANCE_KEYS_V1 = [
  'domain_claim_file',
  'https_probe',
  'functional_probe',
  'repository_api',
  'onchain_read',
  'timestamp_comparison',
  'not_collected',
] as const;

export const B20ProjectEvidenceRowV1Schema = z
  .object({
    chainId: z.literal(8453),
    tokenAddress: Address,
    dimension: z.enum(B20_FUNDAMENTAL_DIMENSION_KEYS_V1),
    state: z.enum(B20_FUNDAMENTAL_STATE_KEYS_V1),
    provenance: z.enum(B20_FUNDAMENTAL_PROVENANCE_KEYS_V1),
    /** What was looked at — always something the PROJECT published. Never a
     * Miorail endpoint, never a credential. Length-bounded so a row cannot
     * carry a response body. */
    reference: z.string().max(2048).nullable(),
    observedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((row, ctx) => {
    // `not_collected` is a state of the WORLD, not a row. A row exists because
    // something was collected; a dimension nobody collected has no row, which
    // is what makes "unknown" the absence of a row rather than a value.
    if (row.provenance === 'not_collected') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'not_collected is the absence of a row, never a stored provenance',
      });
    }
    // The one dimension allowed to be negative is the timestamp comparison.
    if (row.state === 'no' && row.dimension !== 'project_before_token') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `only project_before_token may store a negative state, not ${row.dimension}`,
      });
    }
    // A reference with a secret in it is the failure mode this bounds. Three
    // shapes and no others: an https URL (a probe), a bare address (a contract
    // Miorail read), and a bare hostname — the domain the identity was proven
    // against, which is `miorail.xyz` and NOT `https://miorail.xyz`. Writing it
    // as a URL would name the project's website, and the identity finding is
    // not about a website.
    const referenceOk =
      row.reference === null ||
      /^https:\/\//.test(row.reference) ||
      /^0x[0-9a-fA-F]{40}$/.test(row.reference) ||
      /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(row.reference);
    if (!referenceOk) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a reference must be an https URL, a bare address or a bare domain',
      });
    }
  });

export type B20ProjectEvidenceRowV1 = z.infer<typeof B20ProjectEvidenceRowV1Schema>;

export function assertProjectClaimV1(
  value: unknown,
  direction: 'read' | 'write' = 'read',
): B20ProjectClaimRowV1 {
  const parsed = B20ProjectClaimRowV1Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw new RouteStorageIntegrityError(`B20 project claim failed validation on ${direction}: ${detail}`);
}

export function assertProjectEvidenceV1(
  value: unknown,
  direction: 'read' | 'write' = 'read',
): B20ProjectEvidenceRowV1 {
  const parsed = B20ProjectEvidenceRowV1Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw new RouteStorageIntegrityError(`B20 project evidence failed validation on ${direction}: ${detail}`);
}

/** The refusal a repository raises when evidence is written for a token whose
 * claim does not permit it. A distinct type so a caller cannot mistake it for a
 * transport failure and retry. */
export class B20ProjectClaimRequiredError extends RouteStorageIntegrityError {
  constructor(tokenAddress: string, reason: string) {
    super(`refusing project evidence for ${tokenAddress}: ${reason}`);
    this.name = 'B20ProjectClaimRequiredError';
  }
}

/** One token's stored project record. */
export interface B20ProjectRecordV1 {
  claim: B20ProjectClaimRowV1;
  evidence: readonly B20ProjectEvidenceRowV1[];
}

export interface B20ProjectRepositoryV1 {
  /** Null when no project has claimed this token — the ordinary case. */
  readProject(input: { chainId: number; tokenAddress: string }): Promise<B20ProjectRecordV1 | null>;

  /** Bulk read for a feed page. Returns only tokens with a claim, so a caller
   * cannot tell an absent claim from a failed read by counting. */
  readProjects(input: {
    chainId: number;
    tokenAddresses: readonly string[];
  }): Promise<B20ProjectRecordV1[]>;

  /**
   * One verification pass, written as a unit.
   *
   * The evidence REPLACES whatever was there for this token: a probe that no
   * longer finds a product must not leave the old `live` row behind. And it is
   * refused outright unless the claim in the same call is verified — which is
   * what makes "identity first" a property of the store rather than a habit of
   * its callers.
   */
  recordVerification(input: {
    claim: B20ProjectClaimRowV1;
    evidence: readonly B20ProjectEvidenceRowV1[];
  }): Promise<B20ProjectRecordV1>;

  /** Token addresses whose claim is verified, for the Discover filter. Bounded,
   * because an unbounded list of every claimed token is a query nobody needs. */
  verifiedTokenAddresses(input: { chainId: number; limit: number }): Promise<string[]>;

  /**
   * Verified claims whose evidence is older than a window, oldest first.
   *
   * The verified layer shipped with no expiry: `Product — Live` meant an
   * endpoint answered a real request AT A MOMENT, and nothing ever asked again.
   * Production on 2026-08-18 was serving a product probe observed 36 hours
   * earlier with no sign of its age. This is the queue that closes that.
   *
   * Oldest first, so the reading most likely to have gone false is re-read
   * first, and bounded so a pass cannot spend an unbounded number of outbound
   * requests on somebody else's servers.
   *
   * A claim with NO evidence at all is included: it is as un-current as a claim
   * whose evidence expired, and it is the shape a half-finished pass leaves.
   */
  claimsDueForReverification(input: {
    chainId: number;
    /** Evidence observed before this instant is due. */
    observedBefore: string;
    limit: number;
  }): Promise<{ tokenAddress: string; projectDomain: string; oldestObservedAt: string | null }[]>;

  /**
   * Token addresses carrying a finding in one dimension with one of the given
   * states — the read behind a fundamental predicate.
   *
   * Two properties this method owes its callers:
   *
   * A row is only returned when its claim is STILL VERIFIED. `recordVerification`
   * already refuses to write evidence under a claim that is not, and replaces
   * the whole set on every pass, so an orphan should be impossible — but a read
   * that leans on the writer having been careful is one refactor away from
   * publishing an evidence row whose claim was later refuted. The check belongs
   * on the read.
   *
   * `states` is a set because the states of a dimension are not independent: an
   * `active` repository is also a repository that exists, and a caller asking
   * which projects have one means that row too.
   */
  tokensMatchingEvidence(input: {
    chainId: number;
    dimension: B20FundamentalDimensionKeyV1;
    states: readonly B20FundamentalStateKeyV1[];
    limit: number;
  }): Promise<string[]>;

  /**
   * How many claims on this chain are verified.
   *
   * The denominator a fundamental answer states, and the reason it exists as
   * its own read: a match count means nothing beside the launch universe, whose
   * tokens were never checked. Counted rather than derived from a page, so a
   * bounded list cannot masquerade as the corpus.
   */
  verifiedClaimCount(input: { chainId: number }): Promise<number>;
}

/** Whether a claim permits evidence to be attached. The single place that
 * decision is made, shared by both repository implementations. */
export function claimPermitsEvidenceV1(claim: B20ProjectClaimRowV1): boolean {
  return claim.status === 'verified' && claim.verifiedLinks.length > 0;
}
