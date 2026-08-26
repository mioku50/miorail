import { randomUUID } from 'node:crypto';

import {
  assertIssuerMembershipCheckV1,
  assertIssuerRepresentationV1,
  type IssuerMembershipCheckRecordV1,
  type IssuerRepresentationRepositoryV1,
  type IssuerRepresentationRowV1,
} from './issuerRepresentation.js';

/**
 * The in-memory twin.
 *
 * Holds the same rules Postgres holds: the first sighting is not a change, a
 * row is keyed by the ROOT that answered as well as the address, and a check
 * that did not complete cannot carry a decision. A fake that is more permissive
 * lets a test pass on a history production cannot produce, which is how three
 * shipped bugs got through this seam before.
 */
export function createMemoryIssuerRepresentationRepository(): IssuerRepresentationRepositoryV1 {
  const rows = new Map<string, IssuerRepresentationRowV1>();
  const checks: IssuerMembershipCheckRecordV1[] = [];
  const key = (chainId: number, address: string, issuerId: string, rootKey: string) =>
    `${chainId}:${address.toLowerCase()}:${issuerId}:${rootKey}`;

  return {
    async recordMembership(input) {
      const address = input.tokenAddress.toLowerCase();
      const id = key(input.chainId, address, input.issuerId, input.rootKey);
      const existing = rows.get(id);

      if (!existing) {
        const row = assertIssuerRepresentationV1(
          {
            chainId: input.chainId,
            tokenAddress: address,
            issuerId: input.issuerId,
            rootKey: input.rootKey,
            rootAddress: input.rootAddress.toLowerCase(),
            membership: input.membership,
            blockNumber: input.blockNumber,
            blockHash: input.blockHash,
            evidenceHash: input.evidenceHash,
            firstSeenAt: input.observedAt,
            lastCheckedAt: input.observedAt,
            lastChangedAt: null,
            reads: 1,
            changes: 0,
          },
          'write',
        );
        rows.set(id, row);
        return { outcome: 'first_observation', row };
      }

      const moved = existing.membership !== input.membership;
      const row = assertIssuerRepresentationV1(
        {
          ...existing,
          rootAddress: input.rootAddress.toLowerCase(),
          membership: input.membership,
          blockNumber: input.blockNumber,
          blockHash: input.blockHash,
          evidenceHash: input.evidenceHash,
          lastCheckedAt: input.observedAt,
          lastChangedAt: moved ? input.observedAt : existing.lastChangedAt,
          reads: existing.reads + 1,
          changes: moved ? existing.changes + 1 : existing.changes,
        },
        'write',
      );
      rows.set(id, row);
      return { outcome: moved ? 'changed' : 'unchanged', row };
    },

    async recordCheck(input) {
      const parsed = assertIssuerMembershipCheckV1(input, 'write');
      const record: IssuerMembershipCheckRecordV1 = { ...parsed, checkId: randomUUID() };
      checks.push(record);
      return record;
    },

    async latestCheck(input) {
      const matching = checks
        .filter(
          (check) =>
            check.issuerId === input.issuerId &&
            check.rootKey === input.rootKey &&
            (input.successfulOnly !== true || check.status === 'ok'),
        )
        .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
      return matching[0] ?? null;
    },

    async membershipFor(input) {
      const wanted = new Set(input.tokenAddresses.map((value) => value.toLowerCase()));
      return [...rows.values()]
        .filter((row) => row.chainId === input.chainId && wanted.has(row.tokenAddress))
        .sort(
          (a, b) =>
            a.tokenAddress.localeCompare(b.tokenAddress) || a.issuerId.localeCompare(b.issuerId),
        );
    },

    async establishedRepresentations(input) {
      return [...rows.values()]
        .filter(
          (row) =>
            row.chainId === input.chainId &&
            row.membership === 'established' &&
            (input.issuerId === undefined || row.issuerId === input.issuerId),
        )
        .sort(
          (a, b) =>
            a.issuerId.localeCompare(b.issuerId) || a.tokenAddress.localeCompare(b.tokenAddress),
        )
        .slice(0, Math.max(1, input.limit));
    },
  };
}
