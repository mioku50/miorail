import {
  assertRepresentationSupplyChangeV1,
  assertRepresentationSupplyObservationV1,
  assertRepresentationSupplyV1,
  supplyStateForAmountV1,
  type RepresentationSupplyChangeV1,
  type RepresentationSupplyObservationV1,
  type RepresentationSupplyRepositoryV1,
  type RepresentationSupplyRowV1,
} from './representationSupply.js';

export function createMemoryRepresentationSupplyRepository(): RepresentationSupplyRepositoryV1 {
  const rows = new Map<string, RepresentationSupplyRowV1>();
  const observations: RepresentationSupplyObservationV1[] = [];
  const changes: RepresentationSupplyChangeV1[] = [];
  const keyV1 = (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`;

  return {
    async recordObservation(input) {
      const address = input.tokenAddress.toLowerCase();
      const key = keyV1(input.chainId, address);
      const state = supplyStateForAmountV1(input.totalSupplyAtomic);
      const { now, ...fact } = input;
      const observation = assertRepresentationSupplyObservationV1({
        ...fact,
        tokenAddress: address,
        state,
        normalization: 'raw_erc20_total_supply',
        source: 'erc20_total_supply',
        recordedAt: now,
      });
      const duplicate = observations.some(
        (row) =>
          row.chainId === observation.chainId &&
          row.tokenAddress === observation.tokenAddress &&
          row.blockNumber === observation.blockNumber &&
          row.evidenceHash === observation.evidenceHash,
      );
      const existing = rows.get(key);
      if (duplicate && existing) {
        return {
          outcome: input.readOutcome === 'success' ? 'unchanged' : 'unresolved',
          row: existing,
        };
      }

      const previousSuccessful = [...observations]
        .reverse()
        .find(
          (row) =>
            row.chainId === input.chainId &&
            row.tokenAddress === address &&
            row.readOutcome === 'success',
        );
      observations.push(observation);
      const moved =
        input.readOutcome === 'success' &&
        previousSuccessful?.totalSupplyAtomic !== undefined &&
        previousSuccessful.totalSupplyAtomic !== input.totalSupplyAtomic;
      const transitionAlreadyStored = changes.some(
        (row) =>
          row.chainId === input.chainId &&
          row.tokenAddress === address &&
          row.blockNumber === input.blockNumber,
      );
      if (moved && !transitionAlreadyStored) {
        changes.push(
          assertRepresentationSupplyChangeV1({
            chainId: input.chainId,
            tokenAddress: address,
            fromTotalSupplyAtomic: previousSuccessful!.totalSupplyAtomic,
            toTotalSupplyAtomic: input.totalSupplyAtomic,
            decimals: input.decimals,
            blockNumber: input.blockNumber,
            blockHash: input.blockHash,
            evidenceHash: input.evidenceHash,
            observedAt: input.observedAt,
            recordedAt: input.now,
          }),
        );
      }
      const row = assertRepresentationSupplyV1({
        chainId: input.chainId,
        tokenAddress: address,
        state,
        totalSupplyAtomic: input.totalSupplyAtomic,
        decimals: input.decimals,
        normalization: 'raw_erc20_total_supply',
        blockNumber: input.blockNumber,
        blockHash: input.blockHash,
        source: 'erc20_total_supply',
        evidenceHash: input.evidenceHash,
        readOutcome: input.readOutcome,
        failureCode: input.failureCode,
        observedAt: input.observedAt,
        lastCheckedAt: input.now,
        lastChangedAt:
          moved && !transitionAlreadyStored ? input.now : (existing?.lastChangedAt ?? null),
        reads: (existing?.reads ?? 0) + 1,
        changes: (existing?.changes ?? 0) + (moved && !transitionAlreadyStored ? 1 : 0),
        createdAt: existing?.createdAt ?? input.now,
      });
      rows.set(key, row);
      return {
        outcome:
          input.readOutcome !== 'success'
            ? 'unresolved'
            : !previousSuccessful
              ? 'first_observation'
              : moved
                ? 'changed'
                : 'unchanged',
        row,
      };
    },

    async readSupplies(input) {
      const wanted = new Set(input.tokenAddresses.map((value) => value.toLowerCase()));
      return [...rows.values()]
        .filter((row) => row.chainId === input.chainId && wanted.has(row.tokenAddress))
        .sort((left, right) => left.tokenAddress.localeCompare(right.tokenAddress));
    },

    async recentChanges(input) {
      return changes
        .filter((row) => row.chainId === input.chainId)
        .sort((left, right) => Date.parse(right.recordedAt) - Date.parse(left.recordedAt))
        .slice(0, input.limit);
    },

    async recentObservations(input) {
      return observations
        .filter(
          (row) =>
            row.chainId === input.chainId && row.tokenAddress === input.tokenAddress.toLowerCase(),
        )
        .sort((left, right) => Date.parse(right.recordedAt) - Date.parse(left.recordedAt))
        .slice(0, input.limit);
    },
  };
}
