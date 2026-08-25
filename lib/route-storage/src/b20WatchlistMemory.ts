import {
  b20WatchlistAddEffectV1,
  b20WatchlistFullV1,
  b20WatchlistIdV1,
  type B20WatchlistEntryV1,
  type B20WatchlistRepositoryV1,
} from './b20Watchlist.js';

/**
 * The in-memory watchlist.
 *
 * Same decision function, same ordering, same cap as Postgres. The ordering is
 * copied deliberately rather than left to insertion order: `dueForSweep` is
 * what decides which account's tokens a background run reaches, and a fake that
 * returned them in a friendlier order would hide a starvation bug that only
 * appears once two accounts share a sweep.
 */
export class InMemoryB20WatchlistRepositoryV1 implements B20WatchlistRepositoryV1 {
  private readonly rows = new Map<string, B20WatchlistEntryV1>();

  async addToken(input: { userId: string; tokenAddress: string; now: Date }): Promise<B20WatchlistEntryV1> {
    const address = input.tokenAddress.toLowerCase();
    const id = b20WatchlistIdV1(input.userId, address);
    const existing = this.rows.get(id) ?? null;
    const currentCount = [...this.rows.values()].filter((row) => row.userId === input.userId).length;
    const decision = b20WatchlistAddEffectV1({ existing, currentCount });
    if (decision.effect === 'at_capacity') throw b20WatchlistFullV1(decision.reason);
    if (decision.effect === 'return_existing') return existing!;

    const entry: B20WatchlistEntryV1 = {
      id,
      userId: input.userId,
      chainId: 8453,
      tokenAddress: address,
      createdAt: input.now.toISOString(),
      lastSweptAt: null,
      lastOutcome: null,
    };
    this.rows.set(id, entry);
    return entry;
  }

  async removeToken(userId: string, tokenAddress: string): Promise<boolean> {
    return this.rows.delete(b20WatchlistIdV1(userId, tokenAddress.toLowerCase()));
  }

  async listForUser(userId: string): Promise<B20WatchlistEntryV1[]> {
    return [...this.rows.values()]
      .filter((row) => row.userId === userId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  async dueForSweep(input: { limit: number; sweptBefore: Date }): Promise<B20WatchlistEntryV1[]> {
    const capped = Math.max(1, Math.min(500, Math.trunc(input.limit)));
    const before = input.sweptBefore.getTime();
    return [...this.rows.values()]
      .filter((row) => row.lastSweptAt === null || Date.parse(row.lastSweptAt) < before)
      .sort(
        (left, right) =>
          // NULLS FIRST: a token that has never been read outranks one that has,
          // however long ago.
          compareNullableTimesV1(left.lastSweptAt, right.lastSweptAt) ||
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      )
      .slice(0, capped);
  }

  async recordSweep(input: { id: string; at: Date; outcome: B20WatchlistEntryV1['lastOutcome'] }): Promise<void> {
    const row = this.rows.get(input.id);
    // A sweep that recorded against a token removed mid-run is not an error:
    // the user un-watched it, and the read that already happened is simply not
    // written back to a row that no longer exists.
    if (!row) return;
    this.rows.set(input.id, { ...row, lastSweptAt: input.at.toISOString(), lastOutcome: input.outcome });
  }

  async distinctWatchedAddresses(input: { chainId: number; limit: number }): Promise<string[]> {
    const seen = new Set<string>();
    for (const row of this.rows.values()) {
      if (row.chainId !== input.chainId) continue;
      seen.add(row.tokenAddress);
    }
    // Sorted for the same reason the database sorts: the scheduler diffs this
    // set against what it has scheduled, and an unstable order is churn.
    return [...seen].sort().slice(0, Math.max(1, Math.min(1_000, input.limit)));
  }
}

function compareNullableTimesV1(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return left.localeCompare(right);
}
