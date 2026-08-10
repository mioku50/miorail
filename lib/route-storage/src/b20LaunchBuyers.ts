import { z } from 'zod';

// ---------------------------------------------------------------------------
// The durable half of launch-window buying.
//
// Same shape of cache as `b20LaunchPools`, with one extra rule that matters
// more than anything else here: a row may only be written once its window has
// CLOSED. A launch measured an hour after it happened has most of its window
// still in the future, and storing that would freeze a partial count as final
// — a token showing one buyer forever because that is all there were in the
// first ten minutes.
//
// Aggregates only. The card needs concentration, not a roster of third-party
// wallets.
// ---------------------------------------------------------------------------

const Address = z.string().regex(/^0x[0-9a-f]{40}$/, 'expected a lowercase 20-byte address');
const Digits = z.string().regex(/^\d+$/, 'expected a decimal integer string');
const Bps = z.number().int().min(0).max(10_000);

const WithBuyers = z.object({
  buyerCount: z.number().int().positive(),
  totalBoughtAtomic: Digits.refine((value) => BigInt(value) > 0n, 'buyers with nothing bought'),
  topBuyerShareBps: Bps,
  topThreeShareBps: Bps,
});

const NoBuyers = z.object({
  buyerCount: z.literal(0),
  totalBoughtAtomic: z.literal('0'),
  /** Null, never zero. A concentration among nobody is not 0% — that would
   * render as the safest possible token rather than an untraded one. */
  topBuyerShareBps: z.null(),
  topThreeShareBps: z.null(),
});

const LaunchBuyersRow = z
  .object({
    tokenAddress: Address,
    searchFromBlock: Digits,
    searchToBlock: Digits,
    measuredAt: z.string().datetime(),
  })
  .and(z.union([WithBuyers, NoBuyers]))
  .refine((row) => BigInt(row.searchToBlock) > BigInt(row.searchFromBlock), {
    message: 'the searched window ends at or before it starts',
  })
  .refine(
    (row) => row.topThreeShareBps === null || row.topThreeShareBps >= (row.topBuyerShareBps ?? 0),
    { message: 'the top three cannot hold less than the top one' },
  );

export type B20LaunchBuyersRowV1 = z.infer<typeof LaunchBuyersRow>;

export function assertLaunchBuyersV1(
  row: unknown,
  at: 'read' | 'write' = 'write',
): B20LaunchBuyersRowV1 {
  const parsed = LaunchBuyersRow.safeParse(row);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new Error(
    `b20 launch buyers ${at} rejected: ${issue?.path.join('.') || '(row)'} — ${issue?.message ?? 'invalid'}`,
  );
}

/**
 * True when a stored row answers the window a caller is about to search.
 *
 * Same origin-must-match rule as the pool cache: the window starts at the
 * launch block, so a row searched from elsewhere answers a different question.
 */
export function launchBuyersCoverWindowV1(
  row: Pick<B20LaunchBuyersRowV1, 'searchFromBlock' | 'searchToBlock'>,
  window: { fromBlock: number; toBlock: number },
): boolean {
  return (
    BigInt(row.searchFromBlock) === BigInt(window.fromBlock)
    && BigInt(row.searchToBlock) >= BigInt(window.toBlock)
  );
}

/**
 * Whether the window is over, and therefore whether the answer can be final.
 *
 * The single most important check in this file. Measuring a launch whose
 * window is still open produces a real number about an unfinished period, and
 * caching it would present "one buyer so far" as "one buyer, ever".
 */
export function launchBuyerWindowClosedV1(window: { toBlock: number }, observedHead: number): boolean {
  return Number.isFinite(observedHead) && observedHead >= window.toBlock;
}

export interface B20LaunchBuyersRepositoryV1 {
  readLaunchBuyers(tokenAddress: string): Promise<B20LaunchBuyersRowV1 | null>;
  upsertLaunchBuyers(row: B20LaunchBuyersRowV1): Promise<B20LaunchBuyersRowV1>;
}
