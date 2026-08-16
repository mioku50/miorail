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
  };
}
