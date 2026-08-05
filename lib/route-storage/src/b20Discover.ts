import { z } from 'zod';

import {
  B20_CHAIN_ID_V1,
  B20_FACTORY_V1,
  B20_LAUNCH_DECODER_VERSION_V1,
  type B20LaunchV1,
} from '@mioagent/b20-control';

import { RouteStorageConflictError, RouteStorageIntegrityError } from './types.js';

// ---------------------------------------------------------------------------
// T69 §2/§3/§4/§6/§9 — the durable half of launch ingestion.
//
// Three kinds of record, and they are deliberately not the same kind of thing:
//
//   * A LAUNCH is immutable chain evidence. Once written, its chain identity
//     can never change — not by this file, not by a later migration, not by a
//     careless UPDATE. The only field that may move is whether the chain still
//     contains it, and a reorg sets that.
//
//   * A CURSOR is a claim about how far reading got. It advances strictly
//     forward, in the same commit as the launches it covers, and it carries the
//     hash of the block it names so a reorg beneath it is visible.
//
//   * A RUN is what happened. Including — especially — the runs that failed,
//     because an endpoint that stopped answering must not be indistinguishable
//     from a stretch of chain with no launches in it.
//
// What is NOT stored here, in any table: connection strings, RPC endpoints, API
// keys, headers, or raw provider payloads. Only typed public facts and hashes.
// ---------------------------------------------------------------------------

/** Every way one bounded ingestion pass can end. */
export const B20_DISCOVER_RUN_RESULTS_V1 = [
  /** Read a range, wrote what it found, reached the confirmed head. */
  'success',
  /** The chain has produced nothing new past the confirmation window. */
  'nothing_confirmed',
  /** A budget stopped the run early. What it did not reach is not_checked. */
  'budget_exhausted',
  /** The endpoint did not answer. NOT an empty range. */
  'endpoint_unavailable',
  /** The event shape changed. The feed stops rather than records guesses. */
  'decoder_mismatch',
  /** The chain disagreed with a stored block hash; the cursor went back. */
  'reorg_rewound',
  /** No cursor and no configured start block. An operator must choose. */
  'configuration_required',
  /** The database refused or was unreachable. Cursor and launches unchanged. */
  'storage_unavailable',
  /** Another worker holds the lease. Expected under a timer, not an error. */
  'run_already_active',
] as const;

export type B20DiscoverRunResultV1 = (typeof B20_DISCOVER_RUN_RESULTS_V1)[number];

/**
 * Results that CANNOT have changed anything durable.
 *
 * The database enforces this too (migration 0028). The rule exists because a
 * failed endpoint run that recorded an advanced cursor would silently skip
 * every block it never read.
 */
export const B20_DISCOVER_INERT_RESULTS_V1 = [
  'endpoint_unavailable',
  'decoder_mismatch',
  'configuration_required',
  'storage_unavailable',
  'run_already_active',
] as const;

/** Operator states a cursor can be parked in. Null means ingestion is healthy. */
export const B20_DISCOVER_OPERATOR_STATES_V1 = [
  'decoder_mismatch',
  'endpoint_unavailable',
  'storage_unavailable',
  'reorg_rewound',
] as const;

export type B20DiscoverOperatorStateV1 = (typeof B20_DISCOVER_OPERATOR_STATES_V1)[number];

const HexHash = z.string().regex(/^0x[0-9a-f]{64}$/, 'a lowercase 32-byte hex hash');
const HexAddress = z.string().regex(/^0x[0-9a-f]{40}$/, 'a lowercase 20-byte hex address');
const Uint = z.string().regex(/^\d+$/, 'a non-negative integer as a decimal string');
const Timestamp = z.string().datetime();

/**
 * One launch, as stored.
 *
 * Every field except `canonical`/`nonCanonicalAt` is chain evidence and is
 * immutable once written — see the trigger in migration 0028, which refuses the
 * UPDATE rather than trusting this file to never attempt one.
 */
export const B20StoredLaunchV1Schema = z
  .object({
    /** `${transactionHash}:${logIndex}` — one log is one launch, forever. */
    id: z.string().min(1),
    chainId: z.literal(B20_CHAIN_ID_V1),
    factoryAddress: z.literal(B20_FACTORY_V1),
    tokenAddress: HexAddress,
    variant: z.enum(['asset', 'stablecoin']),
    name: z.string(),
    symbol: z.string(),
    /** Null only when the event carried no readable value. Never defaulted
     * to 18 — a wrong decimals figure misprices every amount downstream. */
    decimals: z.number().int().min(0).max(255).nullable(),
    blockNumber: Uint,
    blockHash: HexHash,
    transactionHash: HexHash,
    transactionIndex: z.number().int().min(0).nullable(),
    /** The block's own timestamp. Null when the endpoint did not report one —
     * a surface then names the block instead of implying a launch time. */
    blockTimestamp: z.string().datetime().nullable(),
    logIndex: z.number().int().min(0),
    /** When this process read it, not when the chain produced it. */
    detectedAt: Timestamp,
    /** How far behind the head it was when ingested, so a shallow read is
     * visible after the fact. */
    confirmationCount: z.number().int().min(0),
    decoderVersion: z.literal(B20_LAUNCH_DECODER_VERSION_V1),
    /** False once a reorg removed the block underneath it. The row is kept —
     * "we saw this and the chain took it back" is itself a fact. */
    canonical: z.boolean(),
    nonCanonicalAt: Timestamp.nullable(),
    createdAt: Timestamp,
  })
  .strict()
  .superRefine((launch, ctx) => {
    if (launch.canonical !== (launch.nonCanonicalAt === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a launch is canonical exactly when it has no non-canonical timestamp',
      });
    }
  });

export type B20StoredLaunchV1 = z.infer<typeof B20StoredLaunchV1Schema>;

/** Identity of one ingestion lane. A different decoder reads a different feed,
 * so it gets its own cursor rather than inheriting one built by another. */
export const B20DiscoverCursorKeyV1Schema = z
  .object({
    chainId: z.literal(B20_CHAIN_ID_V1),
    factoryAddress: z.literal(B20_FACTORY_V1),
    decoderVersion: z.literal(B20_LAUNCH_DECODER_VERSION_V1),
  })
  .strict();

export type B20DiscoverCursorKeyV1 = z.infer<typeof B20DiscoverCursorKeyV1Schema>;

export const B20DiscoverCursorV1Schema = z
  .object({
    id: z.string().min(1),
    chainId: z.literal(B20_CHAIN_ID_V1),
    factoryAddress: z.literal(B20_FACTORY_V1),
    decoderVersion: z.literal(B20_LAUNCH_DECODER_VERSION_V1),
    lastProcessedBlock: Uint,
    /** The hash OF `lastProcessedBlock`. Null only on a cold cursor, which is
     * why a missing hash is not treated as a reorg. */
    lastProcessedBlockHash: HexHash.nullable(),
    operatorState: z.enum(B20_DISCOVER_OPERATOR_STATES_V1).nullable(),
    lastRunId: z.string().min(1).nullable(),
    leaseOwner: z.string().min(1).nullable(),
    leaseExpiresAt: Timestamp.nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .strict()
  .superRefine((cursor, ctx) => {
    if ((cursor.leaseOwner === null) !== (cursor.leaseExpiresAt === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a lease has both an owner and an expiry, or neither',
      });
    }
    if (cursor.id !== discoverCursorIdV1(cursor)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'the cursor id must be derived from its own lane',
      });
    }
  });

export type B20DiscoverCursorV1 = z.infer<typeof B20DiscoverCursorV1Schema>;

export const B20DiscoverRunV1Schema = z
  .object({
    id: z.string().min(1),
    chainId: z.literal(B20_CHAIN_ID_V1),
    factoryAddress: z.literal(B20_FACTORY_V1),
    decoderVersion: z.literal(B20_LAUNCH_DECODER_VERSION_V1),
    startedAt: Timestamp,
    finishedAt: Timestamp,
    startCursorBlock: Uint,
    endCursorBlock: Uint,
    confirmedHead: Uint.nullable(),
    scannedFromBlock: Uint.nullable(),
    scannedToBlock: Uint.nullable(),
    launchesRead: z.number().int().min(0),
    launchesInserted: z.number().int().min(0),
    duplicates: z.number().int().min(0),
    budgetExhausted: z.boolean(),
    operatorState: z.enum(B20_DISCOVER_OPERATOR_STATES_V1).nullable(),
    /** A CATEGORY. Never a provider message, a URL or a response body — the
     * shape is pinned to the same pattern the database CHECKs, because a
     * provider message carries an endpoint and an endpoint carries a key. */
    errorCategory: z
      .string()
      .regex(/^[a-z0-9_]{1,64}$/, 'a short lowercase category code, never a provider message')
      .nullable(),
    result: z.enum(B20_DISCOVER_RUN_RESULTS_V1),
  })
  .strict()
  .superRefine((run, ctx) => {
    if (Date.parse(run.finishedAt) < Date.parse(run.startedAt)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a run cannot finish before it started' });
    }
    if (BigInt(run.endCursorBlock) < BigInt(run.startCursorBlock) && run.result !== 'reorg_rewound') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'only a reorg rewind moves the cursor backwards',
      });
    }
    const inert = (B20_DISCOVER_INERT_RESULTS_V1 as readonly string[]).includes(run.result);
    if (inert && run.launchesInserted > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `a ${run.result} run cannot have stored a launch`,
      });
    }
    if (inert && run.endCursorBlock !== run.startCursorBlock) {
      // The rule the whole feature rests on: a run that failed did not read
      // the range it skipped, and skipping it is permanent.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `a ${run.result} run cannot have moved the cursor`,
      });
    }
    if (run.launchesInserted > run.launchesRead) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'more launches were stored than were read',
      });
    }
  });

export type B20DiscoverRunV1 = z.infer<typeof B20DiscoverRunV1Schema>;

/** The deterministic id of one ingestion lane. */
export function discoverCursorIdV1(key: {
  chainId: number;
  factoryAddress: string;
  decoderVersion: string;
}): string {
  return `${key.chainId}:${key.factoryAddress.toLowerCase()}:${key.decoderVersion}`;
}

/** The one lane this build reads. Named rather than assembled at each call so a
 * second lane cannot appear by typo. */
export const B20_DISCOVER_LANE_V1: B20DiscoverCursorKeyV1 = Object.freeze({
  chainId: B20_CHAIN_ID_V1,
  factoryAddress: B20_FACTORY_V1,
  decoderVersion: B20_LAUNCH_DECODER_VERSION_V1,
});

/**
 * §4 — where a run starts, and whether it may start at all.
 *
 * There is deliberately no "recent enough" fallback derived from the head. A
 * worker that guessed would silently define away every launch before its guess,
 * and nothing downstream could tell that from a quiet chain.
 */
export function discoverStartCursorV1(input: {
  cursor: B20DiscoverCursorV1 | null;
  configuredStartBlock: number | null;
}):
  | { status: 'existing'; cursor: B20DiscoverCursorV1 }
  | { status: 'initialise'; startBlock: string }
  | { status: 'configuration_required' } {
  // An existing cursor always wins. Configuration is a bootstrap value, not a
  // way to move a cursor that is already reading.
  if (input.cursor) return { status: 'existing', cursor: input.cursor };
  if (input.configuredStartBlock === null) return { status: 'configuration_required' };
  if (!Number.isSafeInteger(input.configuredStartBlock) || input.configuredStartBlock < 0) {
    return { status: 'configuration_required' };
  }
  // `startBlock - 1`, because the cursor names the last block ALREADY read and
  // the configured block is the first one the operator wants read.
  return { status: 'initialise', startBlock: String(Math.max(0, input.configuredStartBlock - 1)) };
}

/** A decoded launch as it will be stored. Nothing is invented here: every field
 * comes from the log or from the run that read it. */
export function storedLaunchFromDecodedV1(input: {
  launch: B20LaunchV1;
  detectedAt: string;
  confirmationCount: number;
  transactionIndex?: number | null;
  blockTimestamp?: string | null;
}): B20StoredLaunchV1 {
  return assertStoredLaunchV1({
    id: `${input.launch.transactionHash.toLowerCase()}:${input.launch.logIndex}`,
    chainId: input.launch.chainId,
    factoryAddress: input.launch.factoryAddress,
    tokenAddress: input.launch.tokenAddress,
    variant: input.launch.variant,
    name: input.launch.name,
    symbol: input.launch.symbol,
    decimals: input.launch.decimals,
    blockNumber: input.launch.blockNumber,
    blockHash: input.launch.blockHash,
    transactionHash: input.launch.transactionHash,
    transactionIndex: input.transactionIndex ?? null,
    blockTimestamp: input.blockTimestamp ?? null,
    logIndex: input.launch.logIndex,
    detectedAt: input.detectedAt,
    confirmationCount: input.confirmationCount,
    decoderVersion: input.launch.decoderVersion,
    canonical: true,
    nonCanonicalAt: null,
    createdAt: input.detectedAt,
  });
}

export function assertStoredLaunchV1(value: unknown, direction: 'read' | 'write' = 'read'): B20StoredLaunchV1 {
  const parsed = B20StoredLaunchV1Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw new RouteStorageIntegrityError(`Stored B20 launch failed validation on ${direction}: ${detail}`);
}

export function assertDiscoverCursorV1(value: unknown, direction: 'read' | 'write' = 'read'): B20DiscoverCursorV1 {
  const parsed = B20DiscoverCursorV1Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw new RouteStorageIntegrityError(`B20 discover cursor failed validation on ${direction}: ${detail}`);
}

export function assertDiscoverRunV1(value: unknown, direction: 'read' | 'write' = 'read'): B20DiscoverRunV1 {
  const parsed = B20DiscoverRunV1Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw new RouteStorageIntegrityError(`B20 discover run failed validation on ${direction}: ${detail}`);
}

/**
 * Why a commit must be refused before it reaches the database.
 *
 * The database refuses these too. This exists so the in-memory repository is
 * exactly as strict, and so the refusal has a sentence attached to it.
 */
export function discoverCommitRefusalV1(input: {
  cursor: B20DiscoverCursorV1;
  launches: readonly B20StoredLaunchV1[];
  nextBlock: string;
  nextBlockHash: string;
}): string | null {
  if (BigInt(input.nextBlock) <= BigInt(input.cursor.lastProcessedBlock)) {
    return 'A commit may only move the cursor forward';
  }
  for (const launch of input.launches) {
    if (launch.chainId !== input.cursor.chainId || launch.factoryAddress !== input.cursor.factoryAddress) {
      return 'A launch from another lane cannot be committed against this cursor';
    }
    if (launch.decoderVersion !== input.cursor.decoderVersion) {
      return 'A launch decoded by another decoder version cannot be committed against this cursor';
    }
    const block = BigInt(launch.blockNumber);
    if (block <= BigInt(input.cursor.lastProcessedBlock)) {
      return 'A launch from a block the cursor already passed cannot be committed';
    }
    if (block > BigInt(input.nextBlock)) {
      // Otherwise the cursor would claim to have finished a block whose
      // launches are already stored, and the rest of that block never read.
      return 'A launch beyond the block the cursor is moving to cannot be committed';
    }
  }
  if (!/^0x[0-9a-f]{64}$/.test(input.nextBlockHash)) {
    return 'A cursor may not advance without the hash of the block it names';
  }
  return null;
}

export function discoverConflictV1(message: string): RouteStorageConflictError {
  return new RouteStorageConflictError(message);
}

export interface B20DiscoverCommitResultV1 {
  /** False when the lease was lost or another worker moved the cursor first.
   * Nothing was written in that case — not the cursor, not one launch. */
  committed: boolean;
  inserted: number;
  duplicates: number;
  cursor: B20DiscoverCursorV1 | null;
}

export interface B20DiscoverRewindResultV1 {
  rewound: boolean;
  /** Launches whose block no longer exists on the canonical chain. */
  markedNonCanonical: number;
  cursor: B20DiscoverCursorV1 | null;
}

/**
 * §9 — the contract both repositories implement.
 *
 * The in-memory one is NOT allowed to be kinder than Postgres. Three
 * production bugs in this codebase came from a fake that accepted what the
 * database refuses, which is why the same contract test runs against both.
 */
export interface B20DiscoverRepositoryV1 {
  getCursor(key: B20DiscoverCursorKeyV1): Promise<B20DiscoverCursorV1 | null>;

  /** Idempotent: a lane that already has a cursor keeps it, whatever the
   * configured start block says. */
  initialiseCursor(input: {
    key: B20DiscoverCursorKeyV1;
    startBlock: string;
    now: string;
  }): Promise<B20DiscoverCursorV1>;

  /** Null when another worker holds it. The caller exits `run_already_active`
   * rather than waiting — a queued second worker is just a slower double read. */
  acquireWorkerLease(input: {
    key: B20DiscoverCursorKeyV1;
    owner: string;
    now: string;
    ttlMs: number;
  }): Promise<B20DiscoverCursorV1 | null>;

  releaseWorkerLease(input: { key: B20DiscoverCursorKeyV1; owner: string; now: string }): Promise<void>;

  /**
   * The launches AND the cursor, in one commit. If either fails, neither
   * becomes durable — a cursor that advanced past launches that were not
   * written is exactly the permanent invisible gap this feature is built to
   * avoid.
   */
  commitRange(input: {
    key: B20DiscoverCursorKeyV1;
    owner: string;
    launches: readonly B20StoredLaunchV1[];
    nextBlock: string;
    nextBlockHash: string;
    run: B20DiscoverRunV1;
    now: string;
  }): Promise<B20DiscoverCommitResultV1>;

  /** A run that changed nothing, recorded so that "the endpoint was down" and
   * "the chain was quiet" are different rows. */
  recordFailedRun(input: {
    key: B20DiscoverCursorKeyV1;
    run: B20DiscoverRunV1;
    operatorState: B20DiscoverOperatorStateV1 | null;
  }): Promise<void>;

  rewindForReorg(input: {
    key: B20DiscoverCursorKeyV1;
    owner: string;
    rewindToBlock: string;
    rewindToBlockHash: string | null;
    run: B20DiscoverRunV1;
    now: string;
  }): Promise<B20DiscoverRewindResultV1>;

  listRecentRuns(input: { key: B20DiscoverCursorKeyV1; limit: number }): Promise<B20DiscoverRunV1[]>;

  /** Canonical launches only unless asked otherwise: a reorged-out launch is
   * evidence of what happened, not a token anybody should be shown. */
  listLaunches(input: {
    key: B20DiscoverCursorKeyV1;
    limit: number;
    includeNonCanonical?: boolean;
  }): Promise<B20StoredLaunchV1[]>;
}
