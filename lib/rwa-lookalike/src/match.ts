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

/**
 * WHICH spelling of the official asset was worn.
 *
 * Orthogonal to `matchKind`, which says HOW the strings matched. Measured over
 * the real launch index on 2026-08-25, the three are not the same finding:
 * 12 contracts wore the published ticker, 95 the underlying and 5 the display
 * name. Nobody names a token `AAPLc` by accident -- the trailing `c` is the
 * issuer's convention -- while `COIN` and `META` are ordinary English words,
 * and most of the 95 are exactly that.
 *
 * Recorded, not ranked. It says what matched, never how bad it is.
 */
export const LOOKALIKE_ALIAS_KINDS_V1 = ['published_ticker', 'underlying', 'display_name'] as const;
export type LookalikeAliasKindV1 = (typeof LOOKALIKE_ALIAS_KINDS_V1)[number];

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
  /** Which spelling of the official asset was worn. */
  matchedAlias: LookalikeAliasKindV1;
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
export function officialAliasesV1(
  asset: OfficialIdentityForMatchV1,
): { value: string; kind: LookalikeAliasKindV1 }[] {
  const aliases: { value: string; kind: LookalikeAliasKindV1 }[] = [];
  const seen = new Set<string>();
  const add = (value: string, kind: LookalikeAliasKindV1) => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) return;
    seen.add(trimmed);
    aliases.push({ value: trimmed, kind });
  };
  const ticker = asset.ticker.trim();
  add(ticker, 'published_ticker');
  if (/c$/i.test(ticker) && ticker.length > 1) add(ticker.slice(0, -1), 'underlying');
  add(asset.displayName ?? '', 'display_name');
  return aliases;
}

/**
 * The official asset a launch resembles, or null.
 *
 * `null` is the ordinary answer and means only that nothing matched — never
 * that the launch was checked and found honest.
 *
 * `reviewedRepresentations` is a SECOND, wider set: every address a reviewed
 * issuer root vouches for. It exists because the two sets came apart the
 * moment a second issuer arrived. Measured 2026-08-26, Dinari's Base dShare
 * declares `symbol() = "AAPL"` exactly, and Miorail's own `underlying` alias
 * for `AAPLc` is `AAPL` — so the matcher flags a contract whose issuer's own
 * factory vouches for it, on the strongest match kind there is.
 *
 * It cannot be fixed by adding that contract to `officials`, because nothing
 * reviewed says WHICH security it represents: Dinari's own guidance is that
 * the ticker is a display field. So it is excluded from being a lookalike
 * without being adopted as an alias target — which is exactly the shape of
 * "this is a legitimate contract we cannot yet group".
 */
export function lookalikeMatchV1(input: {
  launch: LaunchForMatchV1;
  officials: readonly OfficialIdentityForMatchV1[];
  /** Addresses a reviewed issuer root vouches for, beyond the alias corpus. */
  reviewedRepresentations?: readonly string[];
}): LookalikeMatchV1 | null {
  const launchAddress = input.launch.tokenAddress.toLowerCase();
  // An official contract is not a lookalike of anything, including of another
  // official asset. Checked before any string is compared, so the strongest
  // possible match cannot outrank identity.
  if (input.officials.some((asset) => asset.tokenAddress.toLowerCase() === launchAddress)) return null;
  // Neither is any other issuer's own contract. Same rule, wider set.
  if (
    input.reviewedRepresentations?.some((address) => address.toLowerCase() === launchAddress) === true
  ) {
    return null;
  }

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
      const normalizedAlias = normalizeIdentityTextV1(alias.value);
      if (normalizedAlias.length === 0) continue;
      if (launchSymbol === alias.value) {
        consider({
          tokenAddress: launchAddress,
          officialAddress,
          matchKind: 'symbol_exact',
          matchedAlias: alias.kind,
          matchedValue: alias.value,
        });
        continue;
      }
      if (normalizedSymbol.length > 0 && normalizedSymbol === normalizedAlias) {
        consider({
          tokenAddress: launchAddress,
          officialAddress,
          matchKind: 'symbol_normalized',
          matchedAlias: alias.kind,
          matchedValue: normalizedAlias,
        });
        continue;
      }
      if (normalizedName.length > 0 && normalizedName === normalizedAlias) {
        consider({
          tokenAddress: launchAddress,
          officialAddress,
          matchKind: 'name_normalized',
          matchedAlias: alias.kind,
          matchedValue: normalizedAlias,
        });
      }
    }
  }
  return best;
}
