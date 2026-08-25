import { z } from 'zod';

import { RouteStorageIntegrityError } from './types.js';

// ---------------------------------------------------------------------------
// The durable half of the shadow market tail.
//
// Three tables and one rule that spans them: a venue transfer may not name a
// venue the store has not identified. Written as a repository invariant rather
// than a caller's habit, because "probably a pool" is exactly the kind of
// evidence that reaches a card as a fact.
//
// Nothing here is called a trade. A pool moves the token for a swap and for a
// liquidity change alike, and the difference costs a second read against the
// venue's own event -- see the migration header for how large the gap measured.
//
// The other rule is idempotency. A transaction and a log index identify one
// log for all time, so re-reading a range writes nothing and the outcome says
// so. That is what lets a pass be retried after a partial failure without any
// coordination, and it is the whole reorg policy that the confirmation depth
// does not cover.
// ---------------------------------------------------------------------------

const Address = z.string().regex(/^0x[0-9a-f]{40}$/, 'expected a lowercase 20-byte address');
const TxHash = z.string().regex(/^0x[0-9a-f]{64}$/, 'expected a lowercase 32-byte transaction hash');
const Digits = z.string().regex(/^\d+$/, 'expected a decimal integer string');

export const MARKET_VENUE_KINDS_V1 = ['candidate', 'paired_pool', 'singleton', 'not_a_venue'] as const;
export type MarketVenueKindV1 = (typeof MARKET_VENUE_KINDS_V1)[number];

export const MARKET_VENUE_TRANSFER_DIRECTIONS_V1 = ['out_of_venue', 'into_venue'] as const;
export type MarketVenueTransferDirectionV1 = (typeof MARKET_VENUE_TRANSFER_DIRECTIONS_V1)[number];

export const MarketVenueRowV1Schema = z
  .object({
    chainId: z.literal(8453),
    address: Address,
    kind: z.enum(MARKET_VENUE_KINDS_V1),
    token0: Address.nullable(),
    token1: Address.nullable(),
    firstSeenAt: z.string().datetime(),
    /** Null only while the address is still a candidate. */
    identifiedAt: z.string().datetime().nullable(),
  })
  .strict()
  .superRefine((row, ctx) => {
    if (row.kind === 'paired_pool' && (row.token0 === null || row.token1 === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a paired pool must carry both sides of its pair',
      });
    }
    if (row.kind !== 'paired_pool' && (row.token0 !== null || row.token1 !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `a ${row.kind} has no pair of its own`,
      });
    }
    if (row.kind !== 'candidate' && row.identifiedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a venue that is not a candidate has been asked, so it carries when',
      });
    }
  });

export type MarketVenueRowV1 = z.infer<typeof MarketVenueRowV1Schema>;

export const MarketVenueTransferRowV1Schema = z
  .object({
    chainId: z.literal(8453),
    tokenAddress: Address,
    venueAddress: Address,
    direction: z.enum(MARKET_VENUE_TRANSFER_DIRECTIONS_V1),
    /** The other side. A router as often as a person -- never a trader. */
    counterparty: Address,
    amountAtomic: Digits,
    blockNumber: z.number().int().positive(),
    transactionHash: TxHash,
    logIndex: z.number().int().min(0),
    observedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((row, ctx) => {
    if (row.counterparty === row.venueAddress) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a venue on both sides is routing, not a movement anybody made',
      });
    }
  });

export type MarketVenueTransferRowV1 = z.infer<typeof MarketVenueTransferRowV1Schema>;

export interface MarketTailCursorV1 {
  tailKey: string;
  chainId: number;
  lastBlock: number;
  lastRunAt: string;
  passes: number;
  logCalls: number;
  identityCalls: number;
  eventsWritten: number;
}

export interface MarketTailPassOutcomeV1 {
  cursor: MarketTailCursorV1;
  /** Events this pass stored for the first time. */
  inserted: number;
  /** Events already present, which is the ordinary result of a re-read. */
  duplicates: number;
  /** Addresses newly recorded, of any kind. */
  venuesAdded: number;
  /** Candidates that this pass answered. */
  venuesIdentified: number;
}

/** How much of a token has moved through venues since a block. The read a
 * first-trade or a sell Signal is built FROM, not the Signal itself: it counts
 * movements, never claims a price, and does not know which of them were
 * swaps. */
export interface MarketVenueActivityV1 {
  tokenAddress: string;
  transfers: number;
  acquired: number;
  disposed: number;
  firstBlock: number;
  lastBlock: number;
}

export function assertMarketVenueV1(value: unknown, direction: 'read' | 'write' = 'read'): MarketVenueRowV1 {
  const parsed = MarketVenueRowV1Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw new RouteStorageIntegrityError(`market venue failed validation on ${direction}: ${detail}`);
}

export function assertMarketVenueTransferV1(
  value: unknown,
  direction: 'read' | 'write' = 'read',
): MarketVenueTransferRowV1 {
  const parsed = MarketVenueTransferRowV1Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw new RouteStorageIntegrityError(`market venue transfer failed validation on ${direction}: ${detail}`);
}

/** Whether a venue may appear on a stored transfer. The single definition, shared
 * by both repositories so neither can be the lenient one. */
export function venueMayCarryTradesV1(kind: MarketVenueKindV1): boolean {
  return kind === 'paired_pool' || kind === 'singleton';
}

/** The refusal raised when an event names an address the store has not
 * identified. A distinct type so a caller cannot mistake it for a transport
 * failure and retry it forever. */
export class MarketVenueUnidentifiedError extends RouteStorageIntegrityError {
  constructor(venueAddress: string, reason: string) {
    super(`refusing a venue transfer on ${venueAddress}: ${reason}`);
    this.name = 'MarketVenueUnidentifiedError';
  }
}

export interface MarketTailRepositoryV1 {
  /** Where the tail got to. Null before its first pass. */
  readCursor(input: { tailKey: string }): Promise<MarketTailCursorV1 | null>;

  /**
   * One pass, written as a unit: what it learned about venues, what it
   * observed, how far it read and what it cost.
   *
   * The cursor never moves backwards. A pass that re-reads the range it just
   * read is accepted and writes nothing, which is how a retry after a partial
   * failure is safe; a pass claiming to have read LESS than the store already
   * has is refused, because that is a worker about to re-scan history while
   * appearing to work.
   */
  recordPass(input: {
    tailKey: string;
    chainId: number;
    toBlock: number;
    observedAt: string;
    logCalls: number;
    identityCalls: number;
    venues: readonly MarketVenueRowV1[];
    events: readonly MarketVenueTransferRowV1[];
  }): Promise<MarketTailPassOutcomeV1>;

  /** Stored venues, bounded. `kinds` narrows to what a caller can act on --
   * candidates to probe, identified pools to read. */
  venues(input: {
    chainId: number;
    kinds?: readonly MarketVenueKindV1[];
    limit: number;
  }): Promise<MarketVenueRowV1[]>;

  /** What has moved through venues since a block, per token. Counts only. */
  venueActivity(input: {
    chainId: number;
    tokenAddresses: readonly string[];
    sinceBlock: number;
  }): Promise<MarketVenueActivityV1[]>;

  /** The newest observed events for one token, newest first, bounded. */
  recentTransfers(input: {
    chainId: number;
    tokenAddress: string;
    limit: number;
  }): Promise<MarketVenueTransferRowV1[]>;
}
