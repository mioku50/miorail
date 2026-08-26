import {
  RATIO_APPLICATION_BY_KIND_V1,
  assertRepresentationRatioChangeV1,
  assertRepresentationRatioV1,
  type RepresentationRatioChangeV1,
  type RepresentationRatioRepositoryV1,
  type RepresentationRatioRowV1,
} from './representationRatio.js';

/**
 * The in-memory twin.
 *
 * It holds the same rules Postgres holds: the first observation is not a
 * change, re-reading the same block writes no second transition, and a stored
 * row always carries the application its kind mandates. A fake that is more
 * permissive lets a test pass on a history production cannot produce — this
 * repository has shipped three production bugs through exactly that gap.
 */
export function createMemoryRepresentationRatioRepository(): RepresentationRatioRepositoryV1 {
  const rows = new Map<string, RepresentationRatioRowV1>();
  const changes: RepresentationRatioChangeV1[] = [];
  const key = (chainId: number, address: string, kind: string) =>
    `${chainId}:${address.toLowerCase()}:${kind}`;

  return {
    async recordRead(input) {
      const address = input.tokenAddress.toLowerCase();
      const id = key(input.chainId, address, input.ratioKind);
      const existing = rows.get(id);
      const application = RATIO_APPLICATION_BY_KIND_V1[input.ratioKind];

      if (!existing) {
        const row = assertRepresentationRatioV1(
          {
            chainId: input.chainId,
            tokenAddress: address,
            ratioKind: input.ratioKind,
            application,
            rawValue: input.rawValue,
            scale: input.scale,
            blockNumber: input.blockNumber,
            blockHash: input.blockHash,
            evidenceHash: input.evidenceHash,
            observedAt: input.observedAt,
            lastCheckedAt: input.now,
            lastChangedAt: null,
            reads: 1,
            changes: 0,
            createdAt: input.now,
          },
          'write',
        );
        rows.set(id, row);
        return { outcome: 'first_observation', row };
      }

      const moved = existing.rawValue !== input.rawValue;
      // Idempotence lives on the block, not on the value: a re-read of the
      // same block is the same observation however many times it is made.
      const alreadyRecorded = changes.some(
        (change) =>
          change.chainId === input.chainId &&
          change.tokenAddress === address &&
          change.ratioKind === input.ratioKind &&
          change.blockNumber === input.blockNumber,
      );

      const row = assertRepresentationRatioV1(
        {
          ...existing,
          rawValue: input.rawValue,
          scale: input.scale,
          blockNumber: input.blockNumber,
          blockHash: input.blockHash,
          evidenceHash: input.evidenceHash,
          observedAt: input.observedAt,
          lastCheckedAt: input.now,
          lastChangedAt: moved ? input.now : existing.lastChangedAt,
          reads: existing.reads + 1,
          changes: moved && !alreadyRecorded ? existing.changes + 1 : existing.changes,
        },
        'write',
      );
      rows.set(id, row);

      if (moved && !alreadyRecorded) {
        changes.push(
          assertRepresentationRatioChangeV1(
            {
              chainId: input.chainId,
              tokenAddress: address,
              ratioKind: input.ratioKind,
              fromRawValue: existing.rawValue,
              toRawValue: input.rawValue,
              scale: input.scale,
              blockNumber: input.blockNumber,
              blockHash: input.blockHash,
              evidenceHash: input.evidenceHash,
              observedAt: input.observedAt,
              recordedAt: input.now,
            },
            'write',
          ),
        );
      }
      return { outcome: moved ? 'changed' : 'unchanged', row };
    },

    async readRatios(input) {
      const wanted = new Set(input.tokenAddresses.map((value) => value.toLowerCase()));
      return [...rows.values()]
        .filter((row) => row.chainId === input.chainId && wanted.has(row.tokenAddress))
        .sort((a, b) => a.tokenAddress.localeCompare(b.tokenAddress));
    },

    async recentChanges(input) {
      return changes
        .filter((change) => change.chainId === input.chainId)
        .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt))
        .slice(0, input.limit);
    },
  };
}
