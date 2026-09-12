import { z } from 'zod';

import { RouteStorageIntegrityError } from './types.js';

// ---------------------------------------------------------------------------
// The corporate-action record for a tokenized stock.
//
// One row per log, stored exactly as the chain emitted it, plus whatever this
// build could decode from it. The migration header carries the reasoning; the
// two rules this contract enforces are:
//
//   * A row is `decoded` or `topic_only`, never a mixture. A half-read
//     announcement reaching a screen as a complete one is the failure this
//     whole vertical is organised against, and here it is refused by the
//     schema and again by a database constraint.
//
//   * The raw log travels with every row. Base publishes topic0 for these
//     events and not which parameters are indexed, so a layout this build
//     cannot read is a gap in OUR reading -- recoverable later, from bytes we
//     kept, rather than a corporate action that never got recorded.
// ---------------------------------------------------------------------------

const Address = z.string().regex(/^0x[0-9a-f]{40}$/, 'expected a lowercase 20-byte address');
const TxHash = z.string().regex(/^0x[0-9a-f]{64}$/, 'expected a lowercase 32-byte transaction hash');
const Topic = z.string().regex(/^0x[0-9a-f]{64}$/, 'expected a lowercase 32-byte topic');
const HexData = z.string().regex(/^0x([0-9a-f]{2})*$/, 'expected lowercase hex with a 0x prefix');
const PositiveDigits = z.string().regex(/^[1-9][0-9]*$/, 'expected a positive integer string');

export const B20_CORPORATE_ACTION_EVENT_KINDS_V1 = [
  'announcement',
  'end_announcement',
  'multiplier_updated',
  'ui_multiplier_updated',
] as const;
export type B20CorporateActionEventKindV1 = (typeof B20_CORPORATE_ACTION_EVENT_KINDS_V1)[number];

/** The cursor key the corporate-action tail advances. Its own, not the ledger
 * tail's: the two read different topics and one failing must not stop the
 * other, which sharing a cursor would guarantee. */
export const B20_CORPORATE_ACTION_TAIL_KEY_V1 = 'b20_corporate_actions' as const;

export const B20CorporateActionRowV1Schema = z
  .object({
    chainId: z.literal(8453),
    tokenAddress: Address,
    event: z.enum(B20_CORPORATE_ACTION_EVENT_KINDS_V1),
    payloadState: z.enum(['decoded', 'topic_only']),
    announcementId: z.string().min(1).max(200).nullable(),
    caller: Address.nullable(),
    description: z.string().min(1).max(2_000).nullable(),
    uri: z.string().min(1).max(2_000).nullable(),
    multiplierWad: PositiveDigits.nullable(),
    topics: z.array(Topic).min(1).max(4),
    data: HexData,
    blockNumber: z.number().int().positive(),
    /** The block's own timestamp: when the action EXECUTED. */
    blockTime: z.string().datetime(),
    transactionHash: TxHash,
    logIndex: z.number().int().min(0),
    /** When we read it. Never the same field as `blockTime`. */
    observedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((row, ctx) => {
    const refuse = (message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    // We cannot have read an action before the chain produced it. Postgres
    // enforces this too; a schema that did not would let the fake accept a row
    // the database refuses, which is how a green unit suite ships an integrity
    // error. See `memory-repo-must-match-postgres`.
    if (Date.parse(row.observedAt) < Date.parse(row.blockTime)) {
      refuse('an action cannot have been observed before the block that carried it');
    }
    const carried =
      row.announcementId !== null ||
      row.caller !== null ||
      row.description !== null ||
      row.uri !== null ||
      row.multiplierWad !== null;
    if (row.payloadState === 'topic_only') {
      if (carried) refuse('a row that read no arguments must carry none');
      return;
    }
    // Decoded means every argument the event declares is present, and nothing
    // that belongs to a different event is.
    if (row.event === 'announcement') {
      if (
        row.announcementId === null ||
        row.caller === null ||
        row.description === null ||
        row.uri === null
      ) {
        refuse('a decoded announcement carries its id, its caller, its description and its uri');
      }
      if (row.multiplierWad !== null) refuse('an announcement does not publish a multiplier');
      return;
    }
    if (row.event === 'end_announcement') {
      if (row.announcementId === null) refuse('a decoded end of announcement carries its id');
      if (row.caller !== null || row.description !== null || row.uri !== null || row.multiplierWad !== null) {
        refuse('the closing bracket carries only the id it closes');
      }
      return;
    }
    if (row.multiplierWad === null) refuse('a decoded multiplier event carries the multiplier');
    if (row.announcementId !== null || row.caller !== null || row.description !== null || row.uri !== null) {
      refuse('a multiplier event carries no announcement text');
    }
  });

export type B20CorporateActionRowV1 = z.infer<typeof B20CorporateActionRowV1Schema>;

export interface B20CorporateActionPassOutcomeV1 {
  /** Rows stored for the first time. */
  inserted: number;
  /** Rows already on file, which is the ordinary result of a re-read. */
  duplicates: number;
  /** Where the tail got to, after this pass. */
  lastBlock: number;
}

/**
 * What the record covers, and how much is in it.
 *
 * The whole point of opening this record before the first corporate action is
 * to be able to say "and nothing before that either". That sentence needs a
 * range, so the range is stored: `firstBlock` is where the tail started,
 * `lastBlock` where it has read to, and `actions` what it found in between.
 *
 * All three are null/zero before the tail has ever run, and a surface must say
 * "nobody has looked" rather than "nothing happened" in that case.
 */
export interface B20CorporateActionCoverageV1 {
  firstBlock: number | null;
  lastBlock: number | null;
  actions: number;
}

export function assertB20CorporateActionV1(
  value: unknown,
  direction: 'read' | 'write' = 'read',
): B20CorporateActionRowV1 {
  const parsed = B20CorporateActionRowV1Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new RouteStorageIntegrityError(
    `b20 corporate action failed validation on ${direction}: ${detail}`,
  );
}

export interface B20CorporateActionRepositoryV1 {
  /**
   * One pass, written as a unit: the rows it read and how far it got.
   *
   * The cursor never moves backwards, for the reason the ledger tail's does
   * not: a tail that rewinds re-scans history while appearing to work.
   */
  recordPass(input: {
    chainId: number;
    /** Where this pass started reading. Stored only when the pass creates the
     * cursor, so the recorded start is the real one and not the latest. */
    fromBlock: number;
    toBlock: number;
    observedAt: string;
    logCalls: number;
    rows: readonly B20CorporateActionRowV1[];
  }): Promise<B20CorporateActionPassOutcomeV1>;

  /** What the record covers. See `B20CorporateActionCoverageV1`. */
  coverage(input: { chainId: number }): Promise<B20CorporateActionCoverageV1>;

  /** One asset's own history, newest first. */
  actionsFor(input: {
    chainId: number;
    tokenAddress: string;
    limit: number;
  }): Promise<B20CorporateActionRowV1[]>;

  /** The market-wide record, newest first. Bounded in the caller, always. */
  recentActions(input: {
    chainId: number;
    since?: string;
    limit: number;
  }): Promise<B20CorporateActionRowV1[]>;
}
