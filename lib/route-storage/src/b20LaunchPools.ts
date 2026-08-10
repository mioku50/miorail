import { z } from 'zod';

// ---------------------------------------------------------------------------
// The durable half of the v4 pool lookup.
//
// `createB20PoolCacheV1` in swap-adapters remembers a resolved pool for one
// measurement pass and says, in its own comment, that the durable cache belongs
// in the database. This is that cache. It is deliberately a plain row type with
// no dependency on the adapter package — the mapping between this and
// `B20PoolResultV1` lives at the one seam that already imports both.
//
// The two rules that make it safe are encoded here as well as in the CHECK
// constraints, because an in-memory repository that accepted what Postgres
// refuses is how three production bugs got in before:
//
//   1. A resolved row carries a COMPLETE PoolKey. A partial key hashes to a
//      pool id that names nothing.
//   2. Absence is cacheable, but only for the window that was actually
//      searched — a wider search later must ask again rather than inherit a
//      narrower "no".
//
// `endpoint_unavailable` has no representation here at all, on purpose. It is
// not a fact about a token and must never be stored as one.
// ---------------------------------------------------------------------------

const Address = z.string().regex(/^0x[0-9a-f]{40}$/, 'expected a lowercase 20-byte address');
const PoolId = z.string().regex(/^0x[0-9a-f]{64}$/, 'expected a 32-byte pool id');
const Digits = z.string().regex(/^\d+$/, 'expected a decimal integer string');

const ResolvedPool = z.object({
  outcome: z.literal('resolved'),
  poolId: PoolId,
  currency0: Address,
  currency1: Address,
  fee: z.number().int().min(0),
  tickSpacing: z.number().int(),
  hooks: Address,
  quoteAsset: Address,
  tokenIsCurrency0: z.boolean(),
  poolBlockNumber: Digits,
});

const AbsentPool = z.object({
  outcome: z.literal('absent'),
  poolId: z.null(),
  currency0: z.null(),
  currency1: z.null(),
  fee: z.null(),
  tickSpacing: z.null(),
  hooks: z.null(),
  quoteAsset: z.null(),
  tokenIsCurrency0: z.null(),
  poolBlockNumber: z.null(),
});

const LaunchPoolRow = z
  .object({
    tokenAddress: Address,
    /** The exact window that was searched, so a reader can tell whether this
     * row answers the question it is about to ask. */
    searchFromBlock: Digits,
    searchToBlock: Digits,
    resolvedAt: z.string().datetime(),
  })
  .and(z.discriminatedUnion('outcome', [ResolvedPool, AbsentPool]))
  .refine(
    (row) => BigInt(row.searchToBlock) >= BigInt(row.searchFromBlock),
    { message: 'the searched window ends before it starts' },
  );

export type B20LaunchPoolRowV1 = z.infer<typeof LaunchPoolRow>;

/** Parses a row, or throws with the field that was wrong. Both repositories
 * call this, which is what keeps the in-memory fake refusing exactly what the
 * CHECK constraints refuse. */
export function assertLaunchPoolV1(row: unknown, at: 'read' | 'write' = 'write'): B20LaunchPoolRowV1 {
  const parsed = LaunchPoolRow.safeParse(row);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new Error(
    `b20 launch pool ${at} rejected: ${issue?.path.join('.') || '(row)'} — ${issue?.message ?? 'invalid'}`,
  );
}

/**
 * True when a stored row answers the window a caller is about to search.
 *
 * The start must MATCH rather than merely contain: the resolver walks windows
 * forward from the launch block, so a row searched from a different origin
 * answers a different question even when the ranges overlap.
 */
export function launchPoolCoversWindowV1(
  row: Pick<B20LaunchPoolRowV1, 'searchFromBlock' | 'searchToBlock'>,
  window: { fromBlock: number; toBlock: number },
): boolean {
  return (
    BigInt(row.searchFromBlock) === BigInt(window.fromBlock)
    && BigInt(row.searchToBlock) >= BigInt(window.toBlock)
  );
}

export interface B20LaunchPoolRepositoryV1 {
  /** The stored answer for this token, or null when nothing was ever searched.
   * Window checking is the caller's, via `launchPoolCoversWindowV1`. */
  readLaunchPool(tokenAddress: string): Promise<B20LaunchPoolRowV1 | null>;
  /** Last write wins: a later search of a wider window supersedes an earlier
   * narrower one, and re-resolving the same window is an ordinary retry. */
  upsertLaunchPool(row: B20LaunchPoolRowV1): Promise<B20LaunchPoolRowV1>;
}
