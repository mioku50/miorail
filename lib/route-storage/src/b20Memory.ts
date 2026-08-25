import type { B20ControlSnapshotV1 } from '@mioagent/b20-control';
import {
  assertB20SnapshotV1,
  b20ConflictV1,
  b20RecordFromSnapshotV1,
  b20SnapshotWriteEffectV1,
  type B20SnapshotRecordV1,
  type B20StorageRepositoryV1,
  type InsertB20SnapshotInputV1,
} from './b20.js';

/**
 * The in-memory B20 repository.
 *
 * It refuses exactly what Postgres refuses, because both call the same
 * decision function and both validate the payload on write and on read. A
 * fake that is kinder than the database is a fake that hides the bugs it was
 * built to catch.
 */
export class InMemoryB20StorageRepositoryV1 implements B20StorageRepositoryV1 {
  private readonly rows = new Map<string, B20SnapshotRecordV1>();
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  /** Mirrors the database's unique index on (user_id, token_address, block_number). */
  private uniqueKey(userId: string, snapshot: B20ControlSnapshotV1): string {
    return `${userId}::${snapshot.tokenAddress}::${snapshot.blockNumber ?? 'null'}`;
  }

  async insertSnapshot(input: InsertB20SnapshotInputV1): Promise<B20SnapshotRecordV1> {
    const snapshot = assertB20SnapshotV1(input.snapshot, 'write');
    const key = this.uniqueKey(input.userId, snapshot);
    const existing = [...this.rows.values()].find(
      (row) => this.uniqueKey(row.userId, row.snapshot) === key,
    );
    const decision = b20SnapshotWriteEffectV1(existing ?? null, snapshot);
    if (decision.effect === 'conflict') throw b20ConflictV1(decision.reason);
    if (decision.effect === 'return_existing') return existing!;

    const record = b20RecordFromSnapshotV1(input.userId, snapshot, this.now().toISOString());
    this.rows.set(record.id, record);
    return record;
  }

  async getSnapshot(id: string, userId: string): Promise<B20SnapshotRecordV1 | null> {
    const row = this.rows.get(id);
    // Tenant isolation is a filter, not a check the caller is trusted to do.
    if (!row || row.userId !== userId) return null;
    assertB20SnapshotV1(row.snapshot, 'read');
    return row;
  }

  async latestSnapshot(userId: string, tokenAddress: string): Promise<B20SnapshotRecordV1 | null> {
    const address = tokenAddress.toLowerCase();
    const matches = [...this.rows.values()]
      .filter((row) => row.userId === userId && row.tokenAddress === address)
      .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt));
    const row = matches[0];
    if (!row) return null;
    assertB20SnapshotV1(row.snapshot, 'read');
    return row;
  }

  async recentSnapshots(
    userId: string,
    tokenAddress: string,
    limit: number,
  ): Promise<B20SnapshotRecordV1[]> {
    // Same cap and same ordering as Postgres. A fake that is more permissive
    // than the database is how three T65 production bugs got in.
    const capped = Math.max(1, Math.min(20, Math.trunc(limit)));
    const address = tokenAddress.toLowerCase();
    const matches = [...this.rows.values()]
      .filter((row) => row.userId === userId && row.tokenAddress === address)
      .sort(
        (left, right) =>
          Date.parse(right.observedAt) - Date.parse(left.observedAt) ||
          compareBlockNumbersV1(right.blockNumber, left.blockNumber) ||
          right.id.localeCompare(left.id),
      )
      .slice(0, capped);
    for (const row of matches) assertB20SnapshotV1(row.snapshot, 'read');
    return matches;
  }
}

/** Block numbers are decimal strings that outgrow Number's safe range, so they
 * are compared as BigInt. A null block (a failed read reached no block) sorts
 * last, matching NULLS LAST in the query this mirrors. */
function compareBlockNumbersV1(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  const a = BigInt(left);
  const b = BigInt(right);
  return a === b ? 0 : a > b ? 1 : -1;
}
