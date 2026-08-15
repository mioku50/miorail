import { z } from 'zod';

import { RouteStorageIntegrityError } from './types.js';

// ---------------------------------------------------------------------------
// The launch transaction's sender, as a stored reading.
//
// Migration 0044 says why this is its own table rather than a column on
// `b20_launches`: the launch row is the decoded LOG and is immutable chain
// evidence, while the sender comes from a later read against an endpoint that
// can be down. Three states have to stay apart and a nullable column collapses
// them into one:
//
//   no row          nobody has read this launch's transaction yet
//   row, sender     the endpoint answered and this is what it said
//   row, no sender  the endpoint answered and the transaction was not there
//
// A FAILED READ WRITES NOTHING. That is the invariant this file exists to
// hold: an endpoint that timed out has not established that a transaction is
// absent, and storing its silence as `deployerAddress: null` would turn an
// outage into a permanent fact about somebody's launch.
// ---------------------------------------------------------------------------

const Address = z.string().regex(/^0x[0-9a-f]{40}$/, 'expected a lowercase 20-byte address');
const Digits = z.string().regex(/^\d+$/, 'expected a decimal integer string');

/** Endpoint FAMILY, never a URL. A URL in a row is a credential waiting to be
 * selected into a diagnostic. */
export const B20_DEPLOYER_SOURCES_V1 = ['base-rpc/v1'] as const;

export const B20LaunchDeployerRowV1Schema = z
  .object({
    /** `${transactionHash}:${logIndex}` — the launch id. */
    launchId: z.string().min(1),
    chainId: z.literal(8453),
    /** Null means the endpoint ANSWERED and the transaction was not there. */
    deployerAddress: Address.nullable(),
    /** The transaction's `to`. Null in the ordinary case; its presence is
     * itself worth seeing, so it is stored rather than dropped. */
    transactionTo: Address.nullable(),
    transactionBlockNumber: Digits.nullable(),
    readAt: z.string().datetime(),
    source: z.enum(B20_DEPLOYER_SOURCES_V1),
  })
  .strict()
  .superRefine((row, ctx) => {
    // An absent transaction has no block and no recipient. Storing either
    // beside a null sender would describe a transaction that was found and
    // then say nobody sent it.
    if (row.deployerAddress === null && (row.transactionTo !== null || row.transactionBlockNumber !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a transaction recorded as absent cannot carry a recipient or a block',
      });
    }
  });

export type B20LaunchDeployerRowV1 = z.infer<typeof B20LaunchDeployerRowV1Schema>;

export function assertLaunchDeployerV1(
  value: unknown,
  direction: 'read' | 'write' = 'read',
): B20LaunchDeployerRowV1 {
  const parsed = B20LaunchDeployerRowV1Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw new RouteStorageIntegrityError(`B20 launch deployer failed validation on ${direction}: ${detail}`);
}

/** Counts for one sender, with the denominator that makes them readable. */
export interface B20DeployerCountsV1 {
  /** Launches from this sender, among those whose sender has been read. */
  launchCount: number;
  /** Their latest stored conclusions, by standing-kind-bearing reason. Kept as
   * raw observation state/reason pairs so the caller maps them with the SAME
   * standing layer the feed uses rather than a second vocabulary. */
  launches: readonly {
    launchId: string;
    tokenAddress: string;
    symbol: string;
    state: string | null;
    reasonCode: string | null;
    exitRouteFound: boolean | null;
  }[];
}

export interface B20LaunchDeployerRepositoryV1 {
  /** Null when nobody has read this launch's transaction. */
  readDeployer(launchId: string): Promise<B20LaunchDeployerRowV1 | null>;

  /** Idempotent on launch id. A second read of the same launch overwrites,
   * because unlike an observation this is not a measurement AT a block — it is
   * a lookup of an immutable fact, and a later read is simply a better one. */
  upsertDeployer(row: B20LaunchDeployerRowV1): Promise<B20LaunchDeployerRowV1>;

  /** Canonical launches with no deployer row yet, oldest first. The backfill's
   * work queue. */
  selectLaunchesWithoutDeployer(input: { limit: number }): Promise<
    { launchId: string; transactionHash: string }[]
  >;

  /** Every launch from one sender, with what was last measured about it. */
  countsForDeployer(input: { deployerAddress: string; limit: number }): Promise<B20DeployerCountsV1>;

  /** How far the read has got: launches with a sender row, and launches total.
   * A count from `countsForDeployer` is meaningless without this pair. */
  deployerCoverage(): Promise<{ launchesRead: number; launchesTotal: number }>;
}
