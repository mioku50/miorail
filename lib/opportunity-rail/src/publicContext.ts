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
  /** Where this candidate came from. `search_result` is the weakest: nobody
   * asserted it, a ranking did. */
  origin: 'search_result' | 'linked_from_website' | 'operator_supplied';
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
  candidates_only: { label: 'Possible public context · Unverified', chip: 'Search results only' },
  nothing_found: { label: 'No public context found', chip: 'Nothing found' },
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
  standing: B20PublicContextStandingV1;
  headline: string;
  detail: string;
  candidates: readonly B20PublicContextCandidateV1[];
  /** Every ground, in order, checked or not. */
  findings: readonly B20PublicContextFindingV1[];
  /** When the search and probes ran. */
  observedAt: string;
}

/** What a probe pass hands in. Every field is something that was READ. */
export interface B20PublicContextEvidenceV1 {
  chainId: number;
  tokenAddress: string;
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

  const standing: B20PublicContextStandingV1 = namesToken
    ? 'names_this_token'
    : linkedCluster
      ? 'linked_cluster'
      : evidence.candidates.length > 0
        ? 'candidates_only'
        : 'nothing_found';

  const detail =
    standing === 'nothing_found'
      ? 'A public search returned nothing Miorail could fetch for this token. That is a statement about the search, not about the token.'
      : standing === 'candidates_only'
        ? `A public search returned ${evidence.candidates.length} result${evidence.candidates.length === 1 ? '' : 's'}. Miorail established none of the grounds below, so these are search results and nothing more. ${B20_PUBLIC_CONTEXT_DISCLAIMER_V1}`
        : standing === 'linked_cluster'
          ? `${B20_PUBLIC_CONTEXT_CLUSTER_ONLY_V1} ${B20_PUBLIC_CONTEXT_DISCLAIMER_V1}`
          : `A page Miorail fetched names this token’s address. ${B20_PUBLIC_CONTEXT_DISCLAIMER_V1}`;

  return {
    chainId: evidence.chainId,
    tokenAddress: evidence.tokenAddress.toLowerCase(),
    standing,
    headline: B20_PUBLIC_CONTEXT_STANDING_COPY_V1[standing].label,
    detail,
    candidates: evidence.candidates,
    findings,
    observedAt: evidence.observedAt,
  };
}
