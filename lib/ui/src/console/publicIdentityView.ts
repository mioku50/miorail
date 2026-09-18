import type { ToneV1 } from './rwaDiscoverView';

// ---------------------------------------------------------------------------
// "Is this the real one?", rendered for somebody with no account.
//
// The whole screen is one verdict and the reader will take the colour before
// they take the words, so the colour is the claim here rather than decoration.
// Two of the five standings are the reason this file exists:
//
//   `unknown_to_miorail` MUST NOT BE GREEN AND MUST NOT BE RED. Nothing has
//   been written down here about that address. Green would say safe, red would
//   say dangerous, and both are claims Miorail has no evidence for. It is the
//   `off` tone every unestablished reading in this product already wears.
//
//   `issuer_representation` is NOT an endorsement of what the token
//   represents. An issuer's registry vouching for an address establishes who
//   deployed it and nothing else — Dinari's Base dShare declares symbol
//   "AAPL" exactly and no reviewed source says which security it stands for.
//   Neutral, and the sentence says both halves.
//
// A lookalike wears `warn`, never `bad`: two strings matched and two addresses
// did not, and that is a resemblance rather than a finding of fraud.
// ---------------------------------------------------------------------------

export interface PublicIdentityReadingV1 {
  schemaVersion: 'address-identity/v1';
  chainId: 8453;
  tokenAddress: string;
  standing:
    | 'reviewed_official'
    | 'delisted_official'
    | 'issuer_representation'
    | 'known_lookalike'
    | 'unknown_to_miorail';
  answer: string;
  official: {
    ticker: string;
    displayName: string | null;
    issuer: string;
    listedIn: readonly { sourceKind: string; currentlyListed: boolean; lastSeenAt: string }[];
  } | null;
  issuerRepresentation: { issuerId: string; rootKey: string; observedAt: string } | null;
  lookalike: {
    officialAddress: string;
    officialTicker: string | null;
    matchKind: string;
    matchedAlias: string;
    matchedValue: string;
    declaredSymbol: string;
    declaredName: string;
    firstFlaggedAt: string;
  } | null;
  corpus: { lookalikeRows: number; lookalikesLastScannedAt: string | null };
  caveats: readonly string[];
  generatedAt: string;
}

export interface PublicIdentityFactV1 {
  label: string;
  value: string;
  note: string | null;
  /** Rendered as a monospace address the reader is meant to compare. */
  mono?: boolean;
}

export interface PublicIdentityViewV1 {
  tokenAddress: string;
  /** Three or four words. What the reader came for. */
  verdict: string;
  tone: ToneV1;
  /** Miorail's own sentence, never rewritten here. */
  answer: string;
  /** The address to compare against, when there is one. Null otherwise —
   * never the checked address repeated back as if it were a match. */
  compareWith: { label: string; address: string } | null;
  facts: readonly PublicIdentityFactV1[];
  caveats: readonly string[];
}

const VERDICT_V1: Readonly<
  Record<PublicIdentityReadingV1['standing'], { verdict: string; tone: ToneV1 }>
> = {
  reviewed_official: { verdict: 'Official', tone: 'good' },
  // The source moved, not the contract. A warning would tell the reader the
  // token changed, and it did not.
  delisted_official: { verdict: 'No longer listed', tone: 'neutral' },
  issuer_representation: { verdict: 'The issuer vouches for it', tone: 'neutral' },
  known_lookalike: { verdict: 'Wearing an official name', tone: 'warn' },
  // Not green, not red. See the header.
  unknown_to_miorail: { verdict: 'Nothing on file here', tone: 'off' },
};

function dayV1(iso: string | null): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

/** How the two strings matched, in words a reader has not had to learn. */
const MATCH_KIND_V1: Readonly<Record<string, string>> = {
  symbol_exact: 'the symbol is identical',
  symbol_normalized: 'the symbol is identical once case and spacing are removed',
  name_normalized: 'the display name is identical once case and spacing are removed',
};

const ALIAS_V1: Readonly<Record<string, string>> = {
  published_ticker: 'the issuer’s published ticker',
  underlying: 'the underlying company ticker',
  display_name: 'the company name',
};

export function publicIdentityViewV1(
  reading: PublicIdentityReadingV1 | null,
): PublicIdentityViewV1 | null {
  if (!reading) return null;
  const { verdict, tone } = VERDICT_V1[reading.standing] ?? {
    verdict: 'Not established',
    tone: 'off' as ToneV1,
  };
  const facts: PublicIdentityFactV1[] = [];
  let compareWith: PublicIdentityViewV1['compareWith'] = null;

  if (reading.official) {
    const current = reading.official.listedIn.filter((row) => row.currentlyListed);
    facts.push({
      label: 'Asset',
      value: reading.official.displayName
        ? `${reading.official.ticker} · ${reading.official.displayName}`
        : reading.official.ticker,
      note: `issued by ${reading.official.issuer}`,
    });
    facts.push({
      label: 'Reviewed sources',
      value: current.length > 0 ? `${current.length} still list it` : 'none list it now',
      // The date is the evidence. "Still listed" with no date is a claim about
      // now made from a reading that could be a week old.
      note: reading.official.listedIn
        .map((row) => `${row.sourceKind} · ${row.currentlyListed ? 'listed' : 'dropped'} ${dayV1(row.lastSeenAt) ?? ''}`.trim())
        .join(' · '),
    });
  }

  if (reading.issuerRepresentation) {
    facts.push({
      label: 'Vouched for by',
      value: reading.issuerRepresentation.issuerId,
      note: `its own registry (${reading.issuerRepresentation.rootKey}), read ${dayV1(reading.issuerRepresentation.observedAt) ?? 'at an unknown time'}`,
    });
    facts.push({
      label: 'What it represents',
      value: 'not established',
      note: 'no reviewed source publishes which security this contract stands for, so Miorail will not name one',
    });
  }

  if (reading.lookalike) {
    const named = reading.lookalike.officialTicker ?? 'an official asset';
    compareWith = { label: named, address: reading.lookalike.officialAddress };
    facts.push({
      label: 'It declared',
      value: reading.lookalike.declaredSymbol || '(no symbol)',
      note: reading.lookalike.declaredName
        ? `name: ${reading.lookalike.declaredName} — copied when it was first flagged, because this metadata can be changed on chain`
        : 'copied when it was first flagged, because this metadata can be changed on chain',
    });
    facts.push({
      label: 'How it matched',
      value: MATCH_KIND_V1[reading.lookalike.matchKind] ?? reading.lookalike.matchKind,
      note: `against ${ALIAS_V1[reading.lookalike.matchedAlias] ?? reading.lookalike.matchedAlias} of ${named} ("${reading.lookalike.matchedValue}")`,
    });
    facts.push({
      label: 'First seen wearing it',
      value: dayV1(reading.lookalike.firstFlaggedAt) ?? 'unknown',
      note: null,
    });
  }

  if (reading.standing === 'unknown_to_miorail') {
    facts.push({
      label: 'Contracts on file wearing an official name',
      value: String(reading.corpus.lookalikeRows),
      // The size of the search says what the silence is worth. "Not found" in
      // an empty table and "not found" among a hundred and sixty are different
      // facts, and only one of them is a search.
      note: reading.corpus.lookalikesLastScannedAt
        ? `this address is not among them; last scanned ${dayV1(reading.corpus.lookalikesLastScannedAt)}`
        : 'no scan has run yet, so this list is not a search',
    });
  }

  return {
    tokenAddress: reading.tokenAddress,
    verdict,
    tone,
    answer: reading.answer,
    compareWith,
    facts,
    caveats: reading.caveats,
  };
}
