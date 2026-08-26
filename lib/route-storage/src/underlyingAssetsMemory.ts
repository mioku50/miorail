import {
  UnknownUnderlyingError,
  assertRepresentationUnderlyingV1,
  assertUnderlyingAssetV1,
  type RepresentationUnderlyingV1,
  type UnderlyingAssetRepositoryV1,
  type UnderlyingAssetV1,
} from './underlyingAssets.js';

/**
 * The in-memory twin.
 *
 * The rule it must hold, because Postgres holds it as a foreign key: a binding
 * to an undeclared underlying is refused. Without that, a test could build a
 * graph whose edges point at nothing and pass, while the same worker throws in
 * production.
 */
export function createMemoryUnderlyingAssetRepository(): UnderlyingAssetRepositoryV1 {
  const underlyings = new Map<string, UnderlyingAssetV1>();
  const bindings = new Map<string, RepresentationUnderlyingV1>();
  const key = (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`;

  return {
    async declareUnderlying(input) {
      const parsed = assertUnderlyingAssetV1(input, 'write');
      const existing = underlyings.get(parsed.underlyingKey);
      // Current projection only moves forward. The database twin uses the
      // same observedAt guard so a delayed worker cannot restore older
      // identity metadata over a newer reviewed observation.
      const row: UnderlyingAssetV1 =
        existing && Date.parse(existing.observedAt) > Date.parse(parsed.observedAt)
          ? existing
          : existing
            ? { ...existing, ...parsed }
            : parsed;
      underlyings.set(parsed.underlyingKey, row);
      return row;
    },

    async bindRepresentation(input) {
      const parsed = assertRepresentationUnderlyingV1(input, 'write');
      if (!underlyings.has(parsed.underlyingKey))
        throw new UnknownUnderlyingError(parsed.underlyingKey);
      const existing = bindings.get(key(parsed.chainId, parsed.tokenAddress));
      const row: RepresentationUnderlyingV1 =
        existing && Date.parse(existing.observedAt) > Date.parse(parsed.observedAt)
          ? existing
          : { ...parsed, tokenAddress: parsed.tokenAddress.toLowerCase() };
      bindings.set(key(row.chainId, row.tokenAddress), row);
      return row;
    },

    async underlyingOf(input) {
      const binding = bindings.get(key(input.chainId, input.tokenAddress));
      if (!binding) return null;
      const underlying = underlyings.get(binding.underlyingKey);
      return underlying ? { binding, underlying } : null;
    },

    async representationsOf(input) {
      return [...bindings.values()]
        .filter((row) => row.chainId === input.chainId && row.underlyingKey === input.underlyingKey)
        .sort((a, b) => a.tokenAddress.localeCompare(b.tokenAddress));
    },

    async underlyingCounts(input) {
      return {
        underlyings: underlyings.size,
        boundRepresentations: [...bindings.values()].filter((row) => row.chainId === input.chainId)
          .length,
      };
    },
  };
}
