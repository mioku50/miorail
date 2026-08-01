import {
  B20ControlSnapshotV1Schema,
  type B20ControlSnapshotV1,
} from '@mioagent/b20-control';
import { RouteStorageConflictError, RouteStorageIntegrityError } from './types.js';

// ---------------------------------------------------------------------------
// T67C — durable B20 Control snapshots.
//
// A snapshot is a read of one token at one block. It is IMMUTABLE, and the
// repository is the thing that makes that true rather than a convention
// everyone remembers: `insertSnapshot` for an id that already exists either
// returns the stored row (when it is byte-identical) or CONFLICTS. There is
// no update path at all, so a later inspection cannot quietly replace what a
// user already read.
//
// The decision below is shared by the in-memory fake and the Postgres
// implementation on purpose. Three T65 production bugs came from a fake that
// accepted what the database refused; a shared decision function is how that
// stops being possible.
// ---------------------------------------------------------------------------

export interface B20SnapshotRecordV1 {
  id: string;
  userId: string;
  chainId: number;
  tokenAddress: string;
  snapshotHash: string;
  identityHash: string;
  blockNumber: string | null;
  blockHash: string | null;
  observedAt: string;
  snapshot: B20ControlSnapshotV1;
  createdAt: string;
}

export interface InsertB20SnapshotInputV1 {
  userId: string;
  snapshot: B20ControlSnapshotV1;
}

export interface B20StorageRepositoryV1 {
  /** Idempotent by (tenant, token, block). Never overwrites. */
  insertSnapshot(input: InsertB20SnapshotInputV1): Promise<B20SnapshotRecordV1>;
  getSnapshot(id: string, userId: string): Promise<B20SnapshotRecordV1 | null>;
  /** The most recent snapshot for a token, for the TTL short-circuit. */
  latestSnapshot(userId: string, tokenAddress: string): Promise<B20SnapshotRecordV1 | null>;

  /**
   * T67F — the most recent snapshots for a token, newest first.
   *
   * The Control Watch sweep needs TWO: the current reading and the one before
   * it. `latestSnapshot` alone cannot serve a cache hit, because on a cache hit
   * the latest row IS the answer and diffing it against itself reports nothing
   * forever.
   */
  recentSnapshots(userId: string, tokenAddress: string, limit: number): Promise<B20SnapshotRecordV1[]>;
}

export type B20WriteEffectV1 =
  | { effect: 'insert' }
  | { effect: 'return_existing' }
  | { effect: 'conflict'; reason: string };

/**
 * What a write against an existing row must do.
 *
 * Shared by both repositories so the fake cannot be more permissive than the
 * database. Re-inspecting at the same block is an ordinary, expected event —
 * the answer is the stored row. A DIFFERENT snapshot claiming the same tenant,
 * token and block is not: the chain had one state at that block, so two
 * disagreeing records mean one of them is wrong, and neither silently wins.
 */
export function b20SnapshotWriteEffectV1(
  existing: B20SnapshotRecordV1 | null,
  incoming: B20ControlSnapshotV1,
): B20WriteEffectV1 {
  if (!existing) return { effect: 'insert' };
  if (existing.snapshotHash === incoming.snapshotHash) return { effect: 'return_existing' };
  return {
    effect: 'conflict',
    reason: 'A different snapshot already exists for this token at this block',
  };
}

/** Validates a snapshot on the way in AND on the way out. A row that stopped
 * satisfying its own schema is refused rather than rendered. */
export function assertB20SnapshotV1(snapshot: unknown, where: 'write' | 'read'): B20ControlSnapshotV1 {
  const parsed = B20ControlSnapshotV1Schema.safeParse(snapshot);
  if (!parsed.success) {
    throw new RouteStorageIntegrityError(
      `B20 control snapshot failed validation on ${where}`,
    );
  }
  return parsed.data;
}

export function b20ConflictV1(reason: string): RouteStorageConflictError {
  return new RouteStorageConflictError(reason);
}

export function b20RecordFromSnapshotV1(
  userId: string,
  snapshot: B20ControlSnapshotV1,
  createdAt: string,
): B20SnapshotRecordV1 {
  return {
    id: snapshot.id,
    userId,
    chainId: snapshot.chainId,
    tokenAddress: snapshot.tokenAddress,
    snapshotHash: snapshot.snapshotHash,
    identityHash: snapshot.identityHash,
    blockNumber: snapshot.blockNumber,
    blockHash: snapshot.blockHash,
    observedAt: snapshot.observedAt,
    snapshot,
    createdAt,
  };
}
