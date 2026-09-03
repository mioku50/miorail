/**
 * Which representations the public cash-exit pass measures.
 *
 * Separated from the pass itself so the rule can be tested without a chain, a
 * router or a database: three times now the corpus has been the bug rather than
 * the measurement, and each time it was invisible because the selection lived
 * inside a script whose `main()` runs on import.
 */
import type {
  OfficialAssetIdentityV1,
  RepresentationSupplyRepositoryV1,
  UnderlyingAssetRepositoryV1,
} from '@mioagent/route-storage';

const CHAIN_ID_V1 = 8453 as const;

/**
 * Only what the selection reads.
 *
 * Narrower than the repository on purpose: a test supplies these three methods
 * exactly, so there is no second implementation of storage to drift from the
 * one Postgres backs.
 */
export type UnderlyingCorpusReaderV1 = Pick<
  UnderlyingAssetRepositoryV1,
  'underlyingCounts' | 'listUnderlyings' | 'representationsOf'
>;
export type SupplyCorpusReaderV1 = Pick<RepresentationSupplyRepositoryV1, 'readSupplies'>;

/** One thing this pass measures, and the words it is allowed to use about it. */
export interface MeasurementTargetV1 {
  tokenAddress: string;
  /**
   * From the reviewed registry when it names one, otherwise read from the token
   * at the anchor block. Display only: a router prices addresses, and nothing
   * in this pass is matched on a symbol.
   */
  symbol: string | null;
  /**
   * The ticker an `official_asset_*` signal may name, or null.
   *
   * Only a member of the reviewed official registry has one. A Dinari dShare
   * that acquires a cash route has undergone a real transition, but it is not
   * an OFFICIAL ASSET transition, and recording one under that name would file
   * a fact about one corpus in the vocabulary of another.
   */
  signalTicker: string | null;
  origin: 'official_registry' | 'reviewed_representation';
}

export const CORPUS_CHOICES_V1 = ['reviewed', 'official'] as const;
export type CorpusV1 = (typeof CORPUS_CHOICES_V1)[number];

/**
 * WHY THE DEFAULT CORPUS IS NO LONGER THE REGISTRY
 *
 * `official_assets` is a snapshot of what ONE issuer currently lists: thirteen
 * tickers. The cards a reader can open come from `representation_underlying`,
 * which holds a hundred and thirty addresses across four issuers. Everything
 * outside the registry was therefore never quoted by this pass and rendered
 * "not measured" for as long as it existed -- a fact about our sweep, printed
 * where a reader reads it as a fact about the asset.
 *
 * `reviewed` is the whole reviewed corpus and is the default. `official`
 * restores the registry-only pass, which is still what `--tickers` selects
 * from.
 */
export function corpusV1(argv: readonly string[]): CorpusV1 {
  const index = argv.indexOf('--corpus');
  if (index < 0) return 'reviewed';
  const value = String(argv[index + 1] ?? '');
  if (!(CORPUS_CHOICES_V1 as readonly string[]).includes(value)) {
    throw new Error(`--corpus takes one of: ${CORPUS_CHOICES_V1.join(', ')}`);
  }
  return value as CorpusV1;
}

/**
 * Reviewed representations that have TOKENS OUTSTANDING.
 *
 * Supply is the gate, and it is not a quality ranking. A contract with zero
 * outstanding has no market by construction: quoting it would spend a third
 * party's capacity to learn what supply already recorded, and the card can say
 * "no tokens outstanding", which is an answer rather than an absence.
 *
 * A representation nobody has read yet is `supply_unknown` and is NOT assumed
 * empty -- it is measured, because that absence is ours and not the market's.
 */
export async function reviewedRepresentationTargetsV1(deps: {
  underlyings: UnderlyingCorpusReaderV1;
  supplies: SupplyCorpusReaderV1;
  limit: number;
}): Promise<MeasurementTargetV1[]> {
  const counts = await deps.underlyings.underlyingCounts({ chainId: CHAIN_ID_V1 });
  const index = await deps.underlyings.listUnderlyings({ chainId: CHAIN_ID_V1, limit: deps.limit });
  // A bounded read that silently returned a page would measure a subset and
  // report it as the corpus, which is the failure this whole pass exists to
  // stop making.
  if (index.length < counts.underlyings) {
    throw new Error(
      `reviewed corpus holds ${counts.underlyings} underlyings and this pass read ${index.length} — raise --underlying-limit rather than measuring a silent subset`,
    );
  }
  const addresses: string[] = [];
  for (const entry of index) {
    const representations = await deps.underlyings.representationsOf({
      chainId: CHAIN_ID_V1,
      underlyingKey: entry.underlying.underlyingKey,
    });
    for (const row of representations) addresses.push(row.tokenAddress.toLowerCase());
  }
  const unique = [...new Set(addresses)];
  const supplies = await deps.supplies.readSupplies({
    chainId: CHAIN_ID_V1,
    tokenAddresses: unique,
  });
  const stateOf = new Map(supplies.map((row) => [row.tokenAddress, row.state]));
  return unique
    .filter((address) => stateOf.get(address) !== 'zero_supply')
    .map((address) => ({
      tokenAddress: address,
      symbol: null,
      signalTicker: null,
      origin: 'reviewed_representation' as const,
    }));
}


/**
 * One target per listed registry member, carrying the ticker a signal may name.
 */
export function registryTargetsV1(
  listed: readonly OfficialAssetIdentityV1[],
): MeasurementTargetV1[] {
  return listed.map((identity) => {
    const listing = identity.listings.find((row) => row.currentlyListed) ?? identity.listings[0]!;
    return {
      tokenAddress: identity.tokenAddress.toLowerCase(),
      symbol: listing.ticker,
      signalTicker: listing.ticker,
      origin: 'official_registry' as const,
    };
  });
}

/**
 * Registry first, then everything reviewed the registry did not already name.
 *
 * The registry entry wins on a shared address because it is the only one
 * carrying a ticker an `official_asset_*` signal is allowed to use. Measuring
 * the same address twice in one pass would also write two runs a minute apart
 * and let the second be compared against the first as if the market had moved.
 */
export function mergeTargetsV1(
  registry: readonly MeasurementTargetV1[],
  reviewed: readonly MeasurementTargetV1[],
): MeasurementTargetV1[] {
  const claimed = new Set(registry.map((target) => target.tokenAddress));
  return [...registry, ...reviewed.filter((target) => !claimed.has(target.tokenAddress))];
}
