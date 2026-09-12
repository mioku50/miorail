import {
  assertB20CorporateActionV1,
  type B20CorporateActionRepositoryV1,
  type B20CorporateActionRowV1,
} from './b20CorporateActions.js';
import { RouteStorageIntegrityError } from './types.js';

// ---------------------------------------------------------------------------
// The in-memory twin.
//
// It refuses what Postgres refuses, in the same order, for the reason recorded
// in `memory-repo-must-match-postgres`: a fake that accepts a row the database
// would reject turns a green unit suite into a production integrity error.
// The unique key, the cursor that cannot rewind and the decoded/topic_only
// completeness rules are all enforced here too.
// ---------------------------------------------------------------------------

export function createMemoryB20CorporateActionRepository(): B20CorporateActionRepositoryV1 {
  const rows: B20CorporateActionRowV1[] = [];
  const seen = new Set<string>();
  let lastBlock: number | null = null;
  let firstBlock: number | null = null;

  const key = (row: B20CorporateActionRowV1) =>
    `${row.chainId}:${row.transactionHash}:${row.logIndex}`;

  return {
    async recordPass(input) {
      if (lastBlock !== null && input.toBlock < lastBlock) {
        throw new RouteStorageIntegrityError(
          `refusing to move the b20_corporate_actions cursor back from ${lastBlock} to ${input.toBlock}: a tail that rewinds re-scans history while appearing to work`,
        );
      }
      let inserted = 0;
      let duplicates = 0;
      for (const candidate of input.rows) {
        const row = assertB20CorporateActionV1(candidate, 'write');
        if (seen.has(key(row))) {
          duplicates += 1;
          continue;
        }
        seen.add(key(row));
        rows.push(row);
        inserted += 1;
      }
      // Written once, like the column. A start that moved with every pass
      // would shrink the range it claims while looking like it grew.
      firstBlock ??= input.fromBlock;
      lastBlock = lastBlock === null ? input.toBlock : Math.max(lastBlock, input.toBlock);
      return { inserted, duplicates, lastBlock };
    },

    async coverage(input) {
      return {
        firstBlock,
        lastBlock,
        actions: rows.filter((row) => row.chainId === input.chainId).length,
      };
    },

    async actionsFor(input) {
      const token = input.tokenAddress.toLowerCase();
      return newestFirstV1(
        rows.filter((row) => row.chainId === input.chainId && row.tokenAddress === token),
      ).slice(0, Math.max(1, Math.min(200, input.limit)));
    },

    async recentActions(input) {
      const since = input.since === undefined ? null : Date.parse(input.since);
      return newestFirstV1(
        rows.filter(
          (row) =>
            row.chainId === input.chainId &&
            (since === null || Date.parse(row.blockTime) >= since),
        ),
      ).slice(0, Math.max(1, Math.min(200, input.limit)));
    },
  };
}

/** Postgres orders by `block_time DESC, id DESC`; `id` is insertion order, so
 * the tiebreak here is the position in the array, reversed. Same order, or the
 * two repositories disagree about which of two same-block rows comes first. */
function newestFirstV1(subset: readonly B20CorporateActionRowV1[]): B20CorporateActionRowV1[] {
  return subset
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const byTime = Date.parse(b.row.blockTime) - Date.parse(a.row.blockTime);
      return byTime !== 0 ? byTime : b.index - a.index;
    })
    .map((entry) => entry.row);
}
