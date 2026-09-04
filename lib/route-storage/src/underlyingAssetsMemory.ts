import {
  UnknownUnderlyingError,
  assertBindRepresentationInputV1,
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
export function createMemoryUnderlyingAssetRepository(
  /**
   * Which representations have tokens outstanding, by lowercase address.
   *
   * The database twin reads this from `representation_supply` and orders the
   * chooser by it. Absent here means the same thing it means there — nobody has
   * read that contract's supply — so the default is an empty map and the
   * ordering falls back to the representation count exactly as Postgres does
   * when the supply table is empty. This exists so the fake cannot rank a list
   * the real one ranks differently.
   */
  supplyStates: ReadonlyMap<string, 'positive_supply' | 'zero_supply' | 'supply_unknown'> = new Map(),
): UnderlyingAssetRepositoryV1 {
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
      // The write gate, not the read one: a new binding must carry complete
      // typed identity. The read schema tolerates a pre-0059 row so history
      // stays legible; nothing may add to that history.
      const parsed = assertBindRepresentationInputV1(input);
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

    async listUnderlyings(input) {
      const byKey = new Map<
        string,
        { count: number; live: number; issuers: Set<string>; perIssuer: Map<string, number> }
      >();
      for (const row of bindings.values()) {
        if (row.chainId !== input.chainId) continue;
        const entry = byKey.get(row.underlyingKey) ?? {
          count: 0,
          live: 0,
          issuers: new Set<string>(),
          perIssuer: new Map<string, number>(),
        };
        entry.count += 1;
        if (supplyStates.get(row.tokenAddress.toLowerCase()) === 'positive_supply') entry.live += 1;
        if (row.issuerId) {
          entry.issuers.add(row.issuerId);
          entry.perIssuer.set(row.issuerId, (entry.perIssuer.get(row.issuerId) ?? 0) + 1);
        }
        byKey.set(row.underlyingKey, entry);
      }
      return [...underlyings.values()]
        .map((underlying) => {
          const entry = byKey.get(underlying.underlyingKey);
          return {
            underlying,
            representationCount: entry?.count ?? 0,
            liveRepresentationCount: entry?.live ?? 0,
            issuerIds: [...(entry?.issuers ?? [])].sort(),
            representationCountsByIssuer: Object.fromEntries(entry?.perIssuer ?? []),
          };
        })
        // A security with tokens outstanding first; then most-represented,
        // because a security Base carries two ways is the only kind this
        // surface can compare. Contract count alone put empty contracts ahead
        // of live markets.
        .sort(
          (a, b) =>
            b.liveRepresentationCount - a.liveRepresentationCount ||
            b.representationCount - a.representationCount ||
            a.underlying.canonicalName.localeCompare(b.underlying.canonicalName) ||
            a.underlying.underlyingKey.localeCompare(b.underlying.underlyingKey),
        )
        .slice(0, Math.max(1, input.limit));
    },

    async underlyingCounts(input) {
      const issuersByKey = new Map<string, Set<string>>();
      for (const row of bindings.values()) {
        if (row.chainId !== input.chainId || !row.issuerId) continue;
        const seen = issuersByKey.get(row.underlyingKey) ?? new Set<string>();
        seen.add(row.issuerId);
        issuersByKey.set(row.underlyingKey, seen);
      }
      return {
        underlyings: underlyings.size,
        boundRepresentations: [...bindings.values()].filter((row) => row.chainId === input.chainId)
          .length,
        // Distinct ISSUERS, never binding count: a rebasing token and its own
        // wrapper are one issuer's structure choice, not a comparison.
        multiIssuerUnderlyings: [...issuersByKey.values()].filter((set) => set.size > 1).length,
      };
    },
  };
}
