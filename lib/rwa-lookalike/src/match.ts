// ---------------------------------------------------------------------------
// Which launches resemble an official asset.
//
// This is the ONE place in Miorail where a name is allowed to matter, and the
// reason it is allowed is that the conclusion runs the other way. Everywhere
// else a name is used to claim identity, which is exactly what a lookalike
// exploits. Here a name is used to say: this contract is NOT the official one
// and it is dressed as if it were. The address still decides who is official;
// the name only decides who is worth warning about.
//
// Two rules follow from that and are enforced rather than remembered:
//
//   * an official address can never be a lookalike of anything, including
//     itself. It is checked here and again in storage, because a matcher is a
//     pure function somebody will one day call with the wrong list.
//   * nothing here says fraud. A resemblance is a resemblance. The product may
//     say "this address does not match the official contract"; it may not say
//     why somebody chose the name, because nothing on chain records that.
//
// Measured 2026-08-25: the official contracts answer AAPLc / NVDAc / METAc,
// while Miorail's own launch index stored AAPL / NVDA / META for the same
// tokens, because B20 metadata is mutable and the index holds what the launch
// event said. So a matcher that knew only the current ticker would miss the
// impostors wearing the OLD name, and one that knew only the old name would
// miss those wearing the new. Both spellings are aliases of one asset.
// ---------------------------------------------------------------------------

export const LOOKALIKE_MATCH_KINDS_V1 = ['symbol_exact', 'symbol_normalized', 'name_normalized'] as const;
export type LookalikeMatchKindV1 = (typeof LOOKALIKE_MATCH_KINDS_V1)[number];

/** Strongest first. A tie between two officials is broken by address, so the
 * same corpus always produces the same answer. */
const MATCH_STRENGTH_V1: Record<LookalikeMatchKindV1, number> = {
  symbol_exact: 3,
  symbol_normalized: 2,
  name_normalized: 1,
};

export interface OfficialIdentityForMatchV1 {
  tokenAddress: string;
  ticker: string;
  displayName: string | null;
}

export interface LaunchForMatchV1 {
  tokenAddress: string;
  symbol: string;
  name: string;
}

export interface LookalikeMatchV1 {
  tokenAddress: string;
  officialAddress: string;
  matchKind: LookalikeMatchKindV1;
  /** The normalized string both sides shared. Stored so a reader can see WHY
   * this was flagged rather than trust that it was. */
  matchedValue: string;
}

/**
 * Case, spacing and punctuation removed; nothing else.
 *
 * Deliberately NOT a fuzzy distance. An edit-distance matcher turns "how
 * similar" into a threshold argument, and every threshold either flags honest
 * tokens or misses dressed ones. Equality after normalization is a fact about
 * two strings; similarity is an opinion about them.
 */
export function normalizeIdentityTextV1(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Every spelling that names one official asset.
 *
 * The ticker as published (`AAPLc`), the underlying it wraps (`AAPL`), and the
 * display name when the source gives one. The underlying is derived by
 * dropping a trailing `c` — which is the issuer's own convention and the
 * reason Miorail's index and the live contract disagree about the same token.
 */
export function officialAliasesV1(asset: OfficialIdentityForMatchV1): string[] {
  const aliases = new Set<string>();
  const ticker = asset.ticker.trim();
  if (ticker.length > 0) {
    aliases.add(ticker);
    if (/c$/i.test(ticker) && ticker.length > 1) aliases.add(ticker.slice(0, -1));
  }
  const name = (asset.displayName ?? '').trim();
  if (name.length > 0) aliases.add(name);
  return [...aliases];
}

/**
 * The official asset a launch resembles, or null.
 *
 * `null` is the ordinary answer and means only that nothing matched — never
 * that the launch was checked and found honest.
 */
export function lookalikeMatchV1(input: {
  launch: LaunchForMatchV1;
  officials: readonly OfficialIdentityForMatchV1[];
}): LookalikeMatchV1 | null {
  const launchAddress = input.launch.tokenAddress.toLowerCase();
  // An official contract is not a lookalike of anything, including of another
  // official asset. Checked before any string is compared, so the strongest
  // possible match cannot outrank identity.
  if (input.officials.some((asset) => asset.tokenAddress.toLowerCase() === launchAddress)) return null;

  const launchSymbol = input.launch.symbol.trim();
  const normalizedSymbol = normalizeIdentityTextV1(launchSymbol);
  const normalizedName = normalizeIdentityTextV1(input.launch.name);

  let best: LookalikeMatchV1 | null = null;
  const consider = (candidate: LookalikeMatchV1) => {
    if (best === null) {
      best = candidate;
      return;
    }
    const byStrength = MATCH_STRENGTH_V1[candidate.matchKind] - MATCH_STRENGTH_V1[best.matchKind];
    if (byStrength > 0 || (byStrength === 0 && candidate.officialAddress < best.officialAddress)) {
      best = candidate;
    }
  };

  for (const asset of input.officials) {
    const officialAddress = asset.tokenAddress.toLowerCase();
    for (const alias of officialAliasesV1(asset)) {
      const normalizedAlias = normalizeIdentityTextV1(alias);
      if (normalizedAlias.length === 0) continue;
      if (launchSymbol === alias) {
        consider({ tokenAddress: launchAddress, officialAddress, matchKind: 'symbol_exact', matchedValue: alias });
        continue;
      }
      if (normalizedSymbol.length > 0 && normalizedSymbol === normalizedAlias) {
        consider({
          tokenAddress: launchAddress,
          officialAddress,
          matchKind: 'symbol_normalized',
          matchedValue: normalizedAlias,
        });
        continue;
      }
      if (normalizedName.length > 0 && normalizedName === normalizedAlias) {
        consider({
          tokenAddress: launchAddress,
          officialAddress,
          matchKind: 'name_normalized',
          matchedValue: normalizedAlias,
        });
      }
    }
  }
  return best;
}
