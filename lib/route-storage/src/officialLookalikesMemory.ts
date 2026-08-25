import {
  assertLookalikeIdentityV1,
  assertOfficialLookalikeV1,
  type OfficialLookalikeOutcomeV1,
  type OfficialLookalikeRepositoryV1,
  type OfficialLookalikeRowV1,
} from './officialLookalikes.js';

/**
 * The in-memory twin.
 *
 * It refuses what the database refuses — a row accusing an official contract,
 * a row naming an official the corpus does not contain, a contract compared
 * with itself — because a fake that is more permissive lets a test pass on a
 * row production cannot store.
 */
export function createMemoryOfficialLookalikeRepository(): OfficialLookalikeRepositoryV1 {
  const rows = new Map<string, OfficialLookalikeRowV1>();
  const key = (chainId: number, tokenAddress: string) => `${chainId}:${tokenAddress.toLowerCase()}`;

  const newestFirst = (left: OfficialLookalikeRowV1, right: OfficialLookalikeRowV1) =>
    Date.parse(right.firstFlaggedAt) - Date.parse(left.firstFlaggedAt) ||
    right.tokenAddress.localeCompare(left.tokenAddress);

  return {
    async recordLookalikes(input) {
      const corpus = new Set(input.officialAddresses.map((address) => address.toLowerCase()));
      const parsed = input.rows.map((row) => assertOfficialLookalikeV1(row, 'write'));
      // Every row is checked BEFORE any is written, so a refused row does not
      // leave half a scan behind.
      for (const row of parsed) assertLookalikeIdentityV1(row, corpus);

      const outcome: OfficialLookalikeOutcomeV1 = { flagged: [], refreshed: [] };
      for (const row of parsed) {
        const id = key(row.chainId, row.tokenAddress);
        const previous = rows.get(id);
        rows.set(id, {
          ...row,
          // When it started wearing the name is a fact a later scan must not
          // reset.
          firstFlaggedAt: previous?.firstFlaggedAt ?? row.firstFlaggedAt,
        });
        (previous ? outcome.refreshed : outcome.flagged).push(row.tokenAddress);
      }
      outcome.flagged.sort();
      outcome.refreshed.sort();
      return outcome;
    },

    async lookalikesOf(input) {
      const official = input.officialAddress.toLowerCase();
      return [...rows.values()]
        .filter((row) => row.chainId === input.chainId && row.officialAddress === official)
        .sort(newestFirst)
        .slice(0, Math.max(1, Math.min(200, input.limit)));
    },

    async lookalikeFor(input) {
      return rows.get(key(input.chainId, input.tokenAddress)) ?? null;
    },

    async recentLookalikes(input) {
      return [...rows.values()]
        .filter((row) => row.chainId === input.chainId)
        .sort(newestFirst)
        .slice(0, Math.max(1, Math.min(200, input.limit)));
    },
  };
}
