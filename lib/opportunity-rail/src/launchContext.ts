// ---------------------------------------------------------------------------
// Launch Context — who sent the transaction, and what else came from there.
//
// Everything identifying in a launch log is written by whoever launched the
// token. A launch calling itself AVANTIS costs nothing and proves nothing, so
// resolving a project by matching a name or a symbol would let one launch
// inherit another project's profile with Miorail vouching for the impostor.
//
// The one field the chain decided rather than the launcher typed is the sender
// of the launch transaction. That is the anchor, and it is an ADDRESS — not a
// team, not a company, not a reputation. What it supports is counting: how
// many other launches came from the same sender and what Miorail measured
// about those. Counts from a stored corpus, never an impression.
//
// Two rules run through this whole file:
//
//   A COUNT IS ONLY AS TRUE AS ITS COVERAGE. "Three launches from this sender"
//   is really "three among the launches whose sender Miorail has read", and
//   that number moves as the backfill runs. Every count here carries the
//   coverage it was computed over, and the copy states it.
//
//   NOTHING HERE CHARACTERISES ANYBODY. No "serial deployer", no "suspicious",
//   no score. A sender with forty launches is a sender with forty launches;
//   what those launches measured is stated separately and in the same
//   vocabulary the feed already uses.
// ---------------------------------------------------------------------------

/** How a launch's sender reading stands. Three states, never two. */
export type B20DeployerReadingV1 =
  /** Nobody has read this launch's transaction yet. Not a property of the
   * launch — a statement about how far the backfill has got. */
  | { status: 'not_read' }
  /** The endpoint answered and named a sender. */
  | { status: 'read'; deployerAddress: string; readAt: string }
  /** The endpoint answered and the transaction was not there. A reorged-away
   * transaction, or an endpoint serving less history than it claims. */
  | { status: 'transaction_absent'; readAt: string };

export const B20_CLAIM_LINKS_V1 = ['launch_sender', 'domain_file', 'project_publication'] as const;
export type B20ClaimLinkV1 = (typeof B20_CLAIM_LINKS_V1)[number];

export const B20_CLAIM_LINK_COPY_V1: Readonly<Record<B20ClaimLinkV1, { label: string; detail: string }>> = {
  launch_sender: {
    label: 'Launch sender',
    detail: 'The launch transaction was sent from an address this project had already published as theirs.',
  },
  domain_file: {
    label: 'File on the project’s domain',
    detail: 'A file served from the project’s own domain names this token address.',
  },
  project_publication: {
    label: 'Published by the project',
    detail: 'The project published this token address on a surface it controls.',
  },
};

export type B20ClaimStatusV1 = 'unverified' | 'verified' | 'refuted';

export interface B20TokenClaimV1 {
  claimantDomain: string;
  status: B20ClaimStatusV1;
  verifiedLinks: readonly B20ClaimLinkV1[];
  refutedLinks: readonly B20ClaimLinkV1[];
  lastCheckedAt: string | null;
}

/**
 * What Miorail will say about who is behind a token.
 *
 * `unverified` is the DEFAULT and the resting state, and it is neither a
 * failure nor an accusation: almost every launch on this chain will never have
 * a claim at all. The headline says what Miorail checked, not what the project
 * is.
 *
 * There is no score. "Verified 1 of 3" plus the checklist is the whole output,
 * because a single number folding unlike evidence together with weights nobody
 * can justify would be sorted, and a ranked list of tokens is an investment
 * signal whatever it is called.
 */
export interface B20ClaimStandingV1 {
  status: B20ClaimStatusV1 | 'no_claim';
  headline: string;
  detail: string;
  /** Checked and passed. */
  verifiedLinks: readonly B20ClaimLinkV1[];
  /** Checked and failed. Distinct from "not checked", which is the remainder. */
  refutedLinks: readonly B20ClaimLinkV1[];
  /** Named rather than implied, so a reader can see the whole checklist and
   * how much of it was actually run. */
  uncheckedLinks: readonly B20ClaimLinkV1[];
  /** `1 of 3`. A fraction, never a percentage and never a rating. */
  verifiedLabel: string;
}

export function b20ClaimStandingV1(claim: B20TokenClaimV1 | null): B20ClaimStandingV1 {
  const total = B20_CLAIM_LINKS_V1.length;
  if (!claim) {
    return {
      status: 'no_claim',
      headline: 'Unverified context.',
      // The default, said as what it is. A launch nobody has claimed is the
      // ordinary case on this chain, and phrasing it as a shortfall would make
      // the common case read as a warning.
      detail:
        'No project has claimed this token to Miorail, so there is nothing to verify. This says nothing about the token — most launches are never claimed.',
      verifiedLinks: [],
      refutedLinks: [],
      uncheckedLinks: B20_CLAIM_LINKS_V1,
      verifiedLabel: `0 of ${total}`,
    };
  }

  const verified = B20_CLAIM_LINKS_V1.filter((link) => claim.verifiedLinks.includes(link));
  const refuted = B20_CLAIM_LINKS_V1.filter((link) => claim.refutedLinks.includes(link));
  const unchecked = B20_CLAIM_LINKS_V1.filter(
    (link) => !verified.includes(link) && !refuted.includes(link),
  );
  const verifiedLabel = `${verified.length} of ${total}`;

  if (claim.status === 'refuted') {
    return {
      status: 'refuted',
      headline: `A claim by ${claim.claimantDomain} did not hold.`,
      detail: `${claim.claimantDomain} claimed this token and at least one check contradicted the claim. This is a statement about that claim, not about the token.`,
      verifiedLinks: verified,
      refutedLinks: refuted,
      uncheckedLinks: unchecked,
      verifiedLabel,
    };
  }
  if (claim.status === 'verified') {
    return {
      status: 'verified',
      headline: `Claimed by ${claim.claimantDomain}.`,
      // What was verified is a LINK, not the project. Saying "verified project"
      // would promote a checked signature into an endorsement.
      detail: `${verifiedLabel} checks link this token to ${claim.claimantDomain}: ${verified
        .map((link) => B20_CLAIM_LINK_COPY_V1[link].label.toLowerCase())
        .join(', ')}. Miorail checked those links and nothing else — it did not review the project, its team or its code.`,
      verifiedLinks: verified,
      refutedLinks: refuted,
      uncheckedLinks: unchecked,
      verifiedLabel,
    };
  }
  return {
    status: 'unverified',
    headline: `A claim by ${claim.claimantDomain} is unverified.`,
    detail: `${claim.claimantDomain} claimed this token and none of the ${total} links has been verified yet. An unverified claim is an assertion by whoever made it.`,
    verifiedLinks: verified,
    refutedLinks: refuted,
    uncheckedLinks: unchecked,
    verifiedLabel,
  };
}

/** What the corpus knows about one sender. Counts, with their denominator. */
export interface B20DeployerCorpusV1 {
  /** Launches from this sender among those whose sender has been read. */
  launchCount: number;
  /** Of those, how many reached each conclusion. Keyed by standing kind so the
   * words match the feed rather than inventing a second vocabulary. */
  standingCounts: readonly { kind: string; count: number }[];
  /** Launches in the whole corpus whose sender HAS been read, and how many
   * exist at all. Without this pair, "three launches from this sender" reads
   * as a complete count of what they did. */
  coverage: { launchesRead: number; launchesTotal: number };
}

export interface B20LaunchContextV1 {
  reading: B20DeployerReadingV1;
  corpus: B20DeployerCorpusV1 | null;
  claim: B20ClaimStandingV1;
  /** Sentences a surface must show beside any of the above. */
  caveats: readonly string[];
}

/** Whether the sender read covers enough of the corpus for its counts to be
 * worth stating as counts at all. Below this the context still reports, and
 * the copy says the count is of a fraction. */
export const B20_DEPLOYER_COVERAGE_FLOOR_BPS_V1 = 5_000;

export function b20LaunchContextCaveatsV1(input: {
  reading: B20DeployerReadingV1;
  corpus: B20DeployerCorpusV1 | null;
}): string[] {
  const caveats: string[] = [
    'The launch sender is an address. It is not a team, a company or a reputation, and Miorail has not identified anyone.',
  ];
  if (input.reading.status === 'not_read') {
    caveats.push('Miorail has not read this launch’s transaction yet, so it does not know who sent it.');
    return caveats;
  }
  if (input.reading.status === 'transaction_absent') {
    caveats.push(
      'The endpoint answered and this launch’s transaction was not there. That is a fact about the read, not about the token.',
    );
    return caveats;
  }
  if (input.corpus) {
    const { launchesRead, launchesTotal } = input.corpus.coverage;
    const bps = launchesTotal === 0 ? 0 : Math.floor((launchesRead * 10_000) / launchesTotal);
    // Stated always, not only when it is low: a count whose denominator is
    // invisible is the shape of every bad number this product has shipped.
    caveats.push(
      `Counts are over the ${launchesRead} of ${launchesTotal} stored launches whose sender Miorail has read. They are not a count of everything this address has done, on this chain or anywhere else.`,
    );
    if (bps < B20_DEPLOYER_COVERAGE_FLOOR_BPS_V1) {
      caveats.push(
        'Less than half the stored launches have had their sender read, so this is a count over a fraction of the corpus and will grow as the backfill runs.',
      );
    }
  }
  return caveats;
}
