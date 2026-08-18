// ---------------------------------------------------------------------------
// Unverified public context.
//
// A separate layer from Fundamental Intelligence, and separate on purpose. That
// one starts from a file a project serves on a domain it controls, and every
// state in it is something Miorail checked against that claim. This one starts
// from a public search, and a search result is a candidate — never a link.
//
// The two must never meet. Nothing in this module produces a
// `B20FundamentalStandingV1`, imports one, or can be turned into one: a
// candidate reaching `verified_project` or `product_backed` is the failure this
// whole design exists to make impossible, so it is prevented structurally
// rather than forbidden by a rule somebody has to remember.
//
// WHAT IS NOT A GROUND HERE, and why it is the most important omission:
//
//   Measured over the 33,541 canonical B20 launches on 2026-08-17, 61.7% share
//   their symbol with another launch. `b20` is the symbol of 950 of them, `myt`
//   of 938. Twelve call themselves `usdc`, sixteen `coinbase`, three `avantis`.
//   The most common NAME, `my token`, is worn by 899 launches.
//
//   So "the name matches" and "the symbol matches" carry no information on this
//   chain. Listing them as grounds would be worse than omitting them: a card
//   showing three ticks reads as substantiated, and two of those ticks would be
//   true of most of the chain. They are not in the list below and there is no
//   field for them.
//
// What IS a ground splits into two questions a reader must not merge:
//
//   Do these accounts belong to each other?   ← the mutual links answer this
//   Do they have anything to do with THIS token? ← only `page_names_token` does
//
// A cluster with no `page_names_token` is a well-linked project that has said
// nothing about this launch. The copy says exactly that.
// ---------------------------------------------------------------------------

/**
 * Every ground this layer can establish, in the order the card shows them.
 *
 * Exhaustive by design: the card renders all of them with their state, checked
 * or not. Three ticks and no denominator reads as "everything matched", which
 * is how a list of what happened to pass becomes a claim.
 */
export const B20_PUBLIC_CONTEXT_GROUNDS_V1 = [
  'page_names_token',
  'site_links_repository',
  'repository_links_site',
  'site_links_social',
  'social_links_site',
] as const;

export type B20PublicContextGroundV1 = (typeof B20_PUBLIC_CONTEXT_GROUNDS_V1)[number];

/**
 * `absent` and `unchecked` are different facts and neither is `found`.
 *
 * `absent` means Miorail fetched the thing and the ground was not there.
 * `unchecked` means Miorail never got to look — no candidate of that kind, or
 * the fetch did not complete. Collapsing them would publish Miorail's own
 * failures as statements about a project.
 */
export const B20_PUBLIC_CONTEXT_GROUND_STATES_V1 = ['found', 'absent', 'unchecked'] as const;
export type B20PublicContextGroundStateV1 = (typeof B20_PUBLIC_CONTEXT_GROUND_STATES_V1)[number];

/** The kinds of public account this layer will look at. Closed: a candidate of
 * any other kind is dropped rather than shown under a guessed label. */
export const B20_PUBLIC_CONTEXT_SOURCES_V1 = ['website', 'repository', 'social'] as const;
export type B20PublicContextSourceKindV1 = (typeof B20_PUBLIC_CONTEXT_SOURCES_V1)[number];

export interface B20PublicContextCandidateV1 {
  kind: B20PublicContextSourceKindV1;
  /** The exact URL a search returned or a fetched page linked to. */
  url: string;
  /** Hostname, for a card that must not print a full third-party URL inline. */
  host: string;
  /**
   * Where this candidate came from, weakest first.
   *
   * `symbol_search` is weaker still than `search_result`: the address search
   * found nothing, so Miorail asked about the NAME — and a name identifies
   * almost nothing here. 61.7% of launches share their symbol; `usdc` is worn
   * by twelve of them. A candidate found that way is very likely somebody
   * else's project, and the card has to say so rather than let a reader
   * discover it.
   */
  origin: 'search_result' | 'symbol_search' | 'linked_from_website' | 'operator_supplied';
  /** True when Miorail fetched it and got an answer. False means every ground
   * that depended on it stays `unchecked`. */
  fetched: boolean;
}

export interface B20PublicContextFindingV1 {
  ground: B20PublicContextGroundV1;
  state: B20PublicContextGroundStateV1;
  /** What was read to reach the state. Null when nothing was read. */
  reference: string | null;
  /** The sentence for this row. Never a score, never a percentage. */
  note: string;
}

/**
 * Four standings, and none of them is a verdict about the project.
 *
 * They describe WHAT MIORAIL READ, in one word, and the ordering is a fact
 * ordering: each is the one below it plus one more thing that was read.
 */
export const B20_PUBLIC_CONTEXT_STANDINGS_V1 = [
  'names_this_token',
  'linked_cluster',
  'candidates_only',
  'nothing_found',
  'lookup_unavailable',
] as const;
export type B20PublicContextStandingV1 = (typeof B20_PUBLIC_CONTEXT_STANDINGS_V1)[number];

export const B20_PUBLIC_CONTEXT_STANDING_COPY_V1: Readonly<
  Record<B20PublicContextStandingV1, { label: string; chip: string }>
> = {
  // Even the strongest one says "unverified". A page that names an address is
  // a page saying something; it is not the project proving control of a domain,
  // which is what the verified layer requires and what this layer never does.
  names_this_token: { label: 'Possible public context · Unverified', chip: 'Names this token' },
  linked_cluster: { label: 'Possible public context · Unverified', chip: 'Linked accounts' },
  candidates_only: { label: 'Possible public context · Unverified', chip: 'Candidates only' },
  nothing_found: { label: 'No public context found', chip: 'Nothing found' },
  // NOT `nothing_found`. A provider that timed out, rate-limited or errored
  // means Miorail could not look, and "could not look" said as "found nothing"
  // is a failure of ours wearing a token's name — the exact defect this
  // codebase has shipped three times before.
  lookup_unavailable: { label: 'Miorail could not look', chip: 'Lookup incomplete' },
};

export const B20_PUBLIC_CONTEXT_GROUND_LABEL_V1: Readonly<Record<B20PublicContextGroundV1, string>> = {
  page_names_token: 'Page names this token',
  site_links_repository: 'Website links to the repository',
  repository_links_site: 'Repository links back to the website',
  site_links_social: 'Website links to the social account',
  social_links_site: 'Social account links back to the website',
};

/** The one sentence this layer exists to make unmissable. */
export const B20_PUBLIC_CONTEXT_DISCLAIMER_V1 =
  'Miorail has not established a cryptographic or project-controlled link between these accounts and this B20 launch. Sharing a name or a symbol with a known project is not a link.';

/** Said whenever a cluster is shown without `page_names_token`. */
export const B20_PUBLIC_CONTEXT_CLUSTER_ONLY_V1 =
  'These accounts link to each other, which is evidence that they are one project. It is not evidence that the project has anything to do with this token — none of them mentions this address.';

/** How a project turns this into the verified layer. Shown on every card, so a
 * reader always knows what the stronger statement would require. */
export const B20_PUBLIC_CONTEXT_PATH_TO_VERIFIED_V1 =
  'A project makes this verifiable by serving /.well-known/miorail-b20.json on its own domain, naming this token. Until then this stays unverified, however well the accounts line up.';

export interface B20PublicContextV1 {
  chainId: number;
  tokenAddress: string;
  /** Carried onto the card so a reader can tell a search from a domain they
   * named, and a completed lookup from one that failed. */
  lookup: B20PublicContextLookupV1;
  standing: B20PublicContextStandingV1;
  headline: string;
  detail: string;
  candidates: readonly B20PublicContextCandidateV1[];
  /** Every ground, in order, checked or not. */
  findings: readonly B20PublicContextFindingV1[];
  /** When the search and probes ran. */
  observedAt: string;
}

/**
 * How the candidates were obtained, and whether that step completed.
 *
 * The projection cannot word an answer honestly without this. A reader who
 * named `orbitlab.xyz` was told "a public search returned 1 result" — there was
 * no search. And a provider timeout produced "a public search returned
 * nothing", which is Miorail's failure stated as a fact about the token.
 */
export interface B20PublicContextLookupV1 {
  kind: 'search' | 'supplied_domain';
  /** True when the address search found nothing and Miorail asked about the
   * name instead. The copy must say this: it is why a card about a token
   * called `usdc` can show a page belonging to Circle. */
  widenedToSymbol?: boolean;
  /** False when the step did not complete: a timeout, a 429, a 500, a socket
   * error. Never conflated with completing and returning nothing. */
  completed: boolean;
  /** The domain a reader named, for `supplied_domain`. */
  suppliedDomain?: string | null;
}

/** What a probe pass hands in. Every field is something that was READ. */
export interface B20PublicContextEvidenceV1 {
  chainId: number;
  tokenAddress: string;
  lookup: B20PublicContextLookupV1;
  candidates: readonly B20PublicContextCandidateV1[];
  /** True only when a fetched page contained this token's address. */
  pageNamesToken: { found: boolean; reference: string | null } | null;
  siteLinksRepository: { found: boolean; reference: string | null } | null;
  repositoryLinksSite: { found: boolean; reference: string | null } | null;
  siteLinksSocial: { found: boolean; reference: string | null } | null;
  socialLinksSite: { found: boolean; reference: string | null } | null;
  observedAt: string;
}

const GROUND_NOTE_V1: Readonly<
  Record<B20PublicContextGroundV1, Record<B20PublicContextGroundStateV1, string>>
> = {
  page_names_token: {
    found: 'A page Miorail fetched contains this token’s address. That is the project saying something about this token, and it is the strongest thing on this card.',
    absent: 'Miorail fetched the page and it does not contain this token’s address.',
    unchecked: 'No page was fetched, so nothing was looked for.',
  },
  site_links_repository: {
    found: 'The website links to this repository.',
    absent: 'The website Miorail fetched links to no repository.',
    unchecked: 'No website was fetched.',
  },
  repository_links_site: {
    found: 'The repository links back to the website, so the two were published by the same people.',
    absent: 'The repository does not link back to the website.',
    unchecked: 'No repository was fetched.',
  },
  site_links_social: {
    found: 'The website links to this social account.',
    absent: 'The website Miorail fetched links to no social account.',
    unchecked: 'No website was fetched.',
  },
  social_links_site: {
    found: 'The social account links back to the website.',
    absent: 'The social account does not link back to the website.',
    unchecked: 'No social account was fetched.',
  },
};

function findingV1(
  ground: B20PublicContextGroundV1,
  read: { found: boolean; reference: string | null } | null,
): B20PublicContextFindingV1 {
  const state: B20PublicContextGroundStateV1 = read === null ? 'unchecked' : read.found ? 'found' : 'absent';
  return {
    ground,
    state,
    reference: read?.reference ?? null,
    note: GROUND_NOTE_V1[ground][state],
  };
}

/**
 * The projection. Pure, and the ONLY place a state becomes a word.
 *
 * Note what it cannot do: there is no branch that returns a fundamental
 * standing, no input that could make it, and no arithmetic anywhere — no score,
 * no percentage, no count of matched grounds presented as a total. A reader
 * gets the grounds and decides.
 */
export function b20PublicContextV1(evidence: B20PublicContextEvidenceV1): B20PublicContextV1 {
  const findings: B20PublicContextFindingV1[] = [
    findingV1('page_names_token', evidence.pageNamesToken),
    findingV1('site_links_repository', evidence.siteLinksRepository),
    findingV1('repository_links_site', evidence.repositoryLinksSite),
    findingV1('site_links_social', evidence.siteLinksSocial),
    findingV1('social_links_site', evidence.socialLinksSite),
  ];

  const namesToken = evidence.pageNamesToken?.found === true;
  // A cluster is two links that point AT EACH OTHER. One direction is a link
  // anyone can add to their own page about somebody else.
  const linkedCluster =
    (evidence.siteLinksRepository?.found === true && evidence.repositoryLinksSite?.found === true) ||
    (evidence.siteLinksSocial?.found === true && evidence.socialLinksSite?.found === true);

  // The lookup itself is checked FIRST, and only when it produced nothing.
  // A provider that failed after returning candidates has still told us
  // something; a provider that failed and returned nothing has not, and the
  // difference between that and an empty result is the whole point.
  const lookupFailed = !evidence.lookup.completed && evidence.candidates.length === 0;

  const standing: B20PublicContextStandingV1 = namesToken
    ? 'names_this_token'
    : linkedCluster
      ? 'linked_cluster'
      : evidence.candidates.length > 0
        ? 'candidates_only'
        : lookupFailed
          ? 'lookup_unavailable'
          : 'nothing_found';

  const supplied = evidence.lookup.suppliedDomain ?? null;
  const bySearch = evidence.lookup.kind === 'search';

  const detail = ((): string => {
    if (standing === 'lookup_unavailable') {
      // Never a sentence about the token. Nothing was read.
      return bySearch
        ? 'The public search did not complete, so Miorail looked at nothing. This says nothing about the token — try again in a moment.'
        : `Miorail could not fetch ${supplied ?? 'that domain'}, so it read nothing. This says nothing about the token.`;
    }
    if (standing === 'nothing_found') {
      return bySearch
        ? 'A public search completed and returned nothing Miorail could fetch for this token. That is a statement about the search, not about the token.'
        : `You supplied ${supplied ?? 'a domain'}. Miorail found nothing on it to read.`;
    }
    if (standing === 'candidates_only') {
      // The defect this replaces: a reader who named a domain was told "a
      // public search returned 1 result", and no search had run.
      const widened = evidence.lookup.widenedToSymbol === true
        ? ' Searching for the address found nothing, so Miorail searched for the name instead — and a name identifies almost nothing here, so these may well belong to a different project entirely.'
        : '';
      const opening = bySearch
        ? `A public search returned ${evidence.candidates.length} result${evidence.candidates.length === 1 ? '' : 's'}. Miorail established none of the grounds below, so these are search results and nothing more.${widened}`
        : `You supplied ${supplied ?? 'a domain'}. Miorail fetched it and did not find this token's address on the page. The domain is shown only as possible public context.`;
      return `${opening} ${B20_PUBLIC_CONTEXT_DISCLAIMER_V1}`;
    }
    if (standing === 'linked_cluster') {
      return `${B20_PUBLIC_CONTEXT_CLUSTER_ONLY_V1} ${B20_PUBLIC_CONTEXT_DISCLAIMER_V1}`;
    }
    const opening = bySearch
      ? 'A page Miorail fetched names this token’s address.'
      : `You supplied ${supplied ?? 'a domain'}. Miorail fetched it and the page names this token’s address.`;
    return `${opening} ${B20_PUBLIC_CONTEXT_DISCLAIMER_V1}`;
  })();

  return {
    chainId: evidence.chainId,
    tokenAddress: evidence.tokenAddress.toLowerCase(),
    lookup: evidence.lookup,
    standing,
    headline: B20_PUBLIC_CONTEXT_STANDING_COPY_V1[standing].label,
    detail,
    candidates: evidence.candidates,
    findings,
    observedAt: evidence.observedAt,
  };
}
