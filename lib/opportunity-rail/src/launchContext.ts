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

/**
 * The B20 factory. A transaction sent straight here was sent by whoever called
 * the factory, with nothing in between.
 */
export const B20_FACTORY_ADDRESS_V1 = '0xb20f000000000000000000000000000000000000';

/**
 * The canonical ERC-4337 EntryPoint.
 *
 * This address is why the whole anchor needed a second look. Measured on the
 * first 300 stored launches: 25 of them were sent to the EntryPoint by only
 * FOUR senders — those senders are bundlers, relaying UserOperations for
 * unrelated people. `tx.from` on such a transaction is whoever paid to include
 * it, and it says nothing at all about who launched the token.
 */
export const ERC4337_ENTRYPOINT_V1 = '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789';

/**
 * What the sender of a launch transaction actually establishes.
 *
 * The reason for the split is STRUCTURAL, not statistical: on a relayed
 * transaction `tx.from` is whoever paid to include it. For an ERC-4337
 * UserOperation that is the bundler, and the actual initiator is inside the
 * operation where a transaction read cannot see it. Grouping launches by
 * `tx.from` — the obvious thing to build — would therefore file unrelated
 * projects under one relayer and print counts about them. That is the failure
 * this product keeps having, in its worst form yet: not our limit wearing a
 * token's name, but one project's record wearing another's.
 *
 * Measured on 2,800 stored launches, which is what the split looks like in
 * practice:
 *
 *   1,165 through one intermediary contract, from 588 senders
 *     731 straight to the factory, from 302 senders
 *     309 through the ERC-4337 EntryPoint, from SIX senders
 *
 * The EntryPoint row is the whole argument in one line. Six addresses account
 * for 309 launches, and they are bundlers.
 *
 * A correction worth keeping: the first 300 launches read showed 121 direct
 * launches from 121 distinct senders, and it looked as though the unambiguous
 * anchor was also always unique. It is not — at ten times the sample there are
 * repeats, one of them with 359 direct launches. An early sample answered a
 * different question than the one it appeared to answer.
 */
export type B20SenderRelationV1 =
  /** Straight to the B20 factory. The sender called it, and nobody stood in
   * between. This is the only relation that supports counting. */
  | 'direct'
  /** Sent to the ERC-4337 EntryPoint, so the sender is a bundler. It is not
   * the launcher and must never be counted as one. */
  | 'bundler'
  /** Through some other contract. The sender paid for the transaction; whether
   * they are the launcher or a relayer for one is not established. */
  | 'intermediary'
  /** The transaction created a contract directly, with no recipient. */
  | 'contract_creation';

export function b20SenderRelationV1(transactionTo: string | null): B20SenderRelationV1 {
  if (transactionTo === null) return 'contract_creation';
  const to = transactionTo.toLowerCase();
  if (to === B20_FACTORY_ADDRESS_V1) return 'direct';
  if (to === ERC4337_ENTRYPOINT_V1) return 'bundler';
  return 'intermediary';
}

/** Whether launches may be counted together because they share a sender. Only
 * `direct` qualifies: everything else shares an address that may belong to
 * infrastructure rather than to a launcher. */
export function b20SenderSupportsCountingV1(relation: B20SenderRelationV1): boolean {
  return relation === 'direct';
}

export const B20_SENDER_RELATION_COPY_V1: Readonly<Record<B20SenderRelationV1, { label: string; detail: string }>> = {
  direct: {
    label: 'Sent straight to the B20 factory',
    detail:
      'This address called the factory itself, with no contract in between. It is the one identity anchor on a launch that nobody can type into a log.',
  },
  bundler: {
    label: 'Relayed through the ERC-4337 EntryPoint',
    detail:
      'The transaction was submitted by a bundler on somebody else’s behalf. The sender paid to include it and is not the launcher — Miorail cannot see who was, and will not guess.',
  },
  intermediary: {
    label: 'Sent through another contract',
    detail:
      'This address paid for the transaction, but a contract stood between it and the factory. Whether it launched the token or relayed for whoever did is not established.',
  },
  contract_creation: {
    label: 'Deployed a contract directly',
    detail: 'The transaction had no recipient — it created a contract. The sender paid for that deployment.',
  },
};

/** How a launch's sender reading stands. Three states, never two. */
export type B20DeployerReadingV1 =
  /** Nobody has read this launch's transaction yet. Not a property of the
   * launch — a statement about how far the backfill has got. */
  | { status: 'not_read' }
  /** The endpoint answered and named a sender. `relation` decides what that
   * sender establishes — and, in particular, whether it may be counted. */
  | { status: 'read'; deployerAddress: string; relation: B20SenderRelationV1; readAt: string }
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
  /** Null whenever the sender does not support counting, which is most of the
   * time. Absence here is the honest state, not a gap to be filled. */
  corpus: B20DeployerCorpusV1 | null;
  claim: B20ClaimStandingV1;
  /** The one-line verdict a surface leads with. */
  headline: string;
  /** Sentences a surface must show beside any of the above. */
  caveats: readonly string[];
}

/**
 * Assembles the context for one launch.
 *
 * The corpus is dropped — not merely hidden — whenever the relation does not
 * support counting. A caller cannot render a count this function refused to
 * make, which is the difference between a rule and a guideline.
 */
export function b20LaunchContextV1(input: {
  reading: B20DeployerReadingV1;
  corpus: B20DeployerCorpusV1 | null;
  claim: B20TokenClaimV1 | null;
}): B20LaunchContextV1 {
  const counts = input.reading.status === 'read' && b20SenderSupportsCountingV1(input.reading.relation)
    ? input.corpus
    : null;
  const claim = b20ClaimStandingV1(input.claim);
  const headline = input.reading.status === 'not_read'
    ? 'Miorail has not read this launch’s transaction.'
    : input.reading.status === 'transaction_absent'
      ? 'This launch’s transaction was not at the endpoint that answered.'
      : B20_SENDER_RELATION_COPY_V1[input.reading.relation].label + '.';
  return {
    reading: input.reading,
    corpus: counts,
    claim,
    headline,
    caveats: [...b20LaunchContextCaveatsV1({ reading: input.reading, corpus: counts }), claim.detail],
  };
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

  caveats.push(B20_SENDER_RELATION_COPY_V1[input.reading.relation].detail);
  if (!b20SenderSupportsCountingV1(input.reading.relation)) {
    // The structural reason, said plainly: on a relayed transaction the sender
    // is whoever paid to include it, so counting would group unrelated
    // projects under one relayer.
    caveats.push(
      'Miorail does not count other launches from this address. On a relayed transaction the sender is whoever paid to include it, so counting them together would group unrelated projects under one address.',
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
    // Measured: one direct sender accounts for 359 of the 731 direct launches
    // read so far. Calling the factory itself proves the address was not
    // relayed; it does not prove the address is the project.
    caveats.push(
      'An address that called the factory many times may be one project or a service launching for many. Miorail cannot tell which, and does not guess.',
    );
    if (bps < B20_DEPLOYER_COVERAGE_FLOOR_BPS_V1) {
      caveats.push(
        'Less than half the stored launches have had their sender read, so this is a count over a fraction of the corpus and will grow as the backfill runs.',
      );
    }
  }
  return caveats;
}
