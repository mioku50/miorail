import {
  B20ProjectClaimRequiredError,
  assertProjectClaimV1,
  assertProjectEvidenceV1,
  claimPermitsEvidenceV1,
  type B20ProjectClaimRowV1,
  type B20ProjectEvidenceRowV1,
  type B20ProjectRecordV1,
  type B20ProjectRepositoryV1,
} from './b20Projects.js';

/**
 * The in-memory twin.
 *
 * It validates through the same asserts the database path uses and refuses the
 * same writes — a verified claim with no verified link, evidence for a token
 * whose claim is not verified, a negative state on a dimension that may not be
 * negative. A fake that accepted any of those would let a test pass on a row
 * Postgres could never store.
 */
export function createMemoryB20ProjectRepository(): B20ProjectRepositoryV1 {
  const claims = new Map<string, B20ProjectClaimRowV1>();
  const evidence = new Map<string, B20ProjectEvidenceRowV1[]>();
  const key = (chainId: number, tokenAddress: string) => `${chainId}:${tokenAddress.toLowerCase()}`;

  return {
    async readProject(input) {
      const claim = claims.get(key(input.chainId, input.tokenAddress));
      if (!claim) return null;
      return { claim, evidence: evidence.get(key(input.chainId, input.tokenAddress)) ?? [] };
    },

    async readProjects(input) {
      const found: B20ProjectRecordV1[] = [];
      for (const address of input.tokenAddresses) {
        const claim = claims.get(key(input.chainId, address));
        if (!claim) continue;
        found.push({ claim, evidence: evidence.get(key(input.chainId, address)) ?? [] });
      }
      return found;
    },

    async recordVerification(input) {
      const claim = assertProjectClaimV1(input.claim, 'write');
      const rows = input.evidence.map((row) => assertProjectEvidenceV1(row, 'write'));

      if (rows.length > 0 && !claimPermitsEvidenceV1(claim)) {
        throw new B20ProjectClaimRequiredError(
          claim.tokenAddress,
          `the claim by ${claim.claimantDomain} is ${claim.status}, so no project evidence may be attached`,
        );
      }
      // Evidence belongs to the token its claim is for. A row for a different
      // token in the same call is the shape of one project's record landing on
      // another's card.
      for (const row of rows) {
        if (row.tokenAddress !== claim.tokenAddress || row.chainId !== claim.chainId) {
          throw new B20ProjectClaimRequiredError(
            row.tokenAddress,
            'evidence must belong to the token its claim was verified for',
          );
        }
      }

      const id = key(claim.chainId, claim.tokenAddress);
      claims.set(id, claim);
      // Replaces. A probe that no longer finds a product must not leave the
      // previous `live` row standing.
      evidence.set(id, rows);
      return { claim, evidence: rows };
    },

    async verifiedTokenAddresses(input) {
      return [...claims.values()]
        .filter((claim) => claim.chainId === input.chainId && claim.status === 'verified')
        .map((claim) => claim.tokenAddress)
        .sort()
        .slice(0, input.limit);
    },

    async claimsDueForReverification(input) {
      const due: { tokenAddress: string; projectDomain: string; oldestObservedAt: string | null }[] = [];
      for (const claim of claims.values()) {
        if (claim.chainId !== input.chainId) continue;
        if (claim.status !== 'verified') continue;
        const rows = evidence.get(key(claim.chainId, claim.tokenAddress)) ?? [];
        const stamps = rows
          .map((row) => row.observedAt)
          .filter((observedAt): observedAt is string => typeof observedAt === 'string');
        // No evidence at all is due, exactly as Postgres treats it.
        const oldest = stamps.length === 0
          ? null
          : stamps.reduce((left, right) => (Date.parse(left) <= Date.parse(right) ? left : right));
        if (oldest !== null && Date.parse(oldest) >= Date.parse(input.observedBefore)) continue;
        due.push({
          tokenAddress: claim.tokenAddress,
          projectDomain: claim.claimantDomain,
          oldestObservedAt: oldest,
        });
      }
      // Oldest first, nulls before everything, then the address — the same
      // total order the database produces.
      return due
        .sort((left, right) => {
          if (left.oldestObservedAt === right.oldestObservedAt) {
            return left.tokenAddress.localeCompare(right.tokenAddress);
          }
          if (left.oldestObservedAt === null) return -1;
          if (right.oldestObservedAt === null) return 1;
          return Date.parse(left.oldestObservedAt) - Date.parse(right.oldestObservedAt);
        })
        .slice(0, Math.max(1, Math.min(200, input.limit)));
    },

    async tokensMatchingEvidence(input) {
      const matched: string[] = [];
      for (const claim of claims.values()) {
        if (claim.chainId !== input.chainId) continue;
        // The same condition the database expresses as a JOIN on the claim.
        // Written here too rather than assumed from the write path, because a
        // read that trusts the writer publishes an orphaned row the day the
        // writer changes.
        if (claim.status !== 'verified') continue;
        const rows = evidence.get(key(claim.chainId, claim.tokenAddress)) ?? [];
        const hit = rows.some(
          (row) => row.dimension === input.dimension && input.states.includes(row.state),
        );
        if (hit) matched.push(claim.tokenAddress);
      }
      return matched.sort().slice(0, input.limit);
    },

    async verifiedClaimCount(input) {
      return [...claims.values()].filter(
        (claim) => claim.chainId === input.chainId && claim.status === 'verified',
      ).length;
    },
  };
}
