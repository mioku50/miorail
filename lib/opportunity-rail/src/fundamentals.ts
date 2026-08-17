// ---------------------------------------------------------------------------
// B20 Fundamental Intelligence V1 — is there a real project behind this token?
//
// Everything in a launch log is typed by whoever launched the token, so the
// question cannot be answered by looking at a token. It is answered by starting
// from an identity that was PROVEN and following only what that identity
// published about itself:
//
//   token ──(claim: launch sender / domain file / project publication)──▶ domain
//   domain ──(the project's own declaration)──▶ website, product, repo, docs
//   each declared thing ──(a probe)──▶ one state, with provenance and a time
//
// Break the first link and nothing after it may be attached. A token that
// merely shares a symbol with a known project has no claim, so it inherits
// nothing — which is the failure this whole layer is built to prevent, and it
// is prevented structurally rather than by a check somebody could forget.
//
// Four rules run through the file:
//
//   UNKNOWN IS NEVER NO. Absence of evidence is its own state everywhere. The
//   ONE dimension that can say "no" is `project_before_token`, and only with
//   two timestamps in hand — a repository creation date and a launch time.
//
//   A WEBSITE IS NOT A PRODUCT. A reachable page proves a page. `live` needs a
//   declared product endpoint to answer a FUNCTIONAL probe with structured
//   data, which a landing page does not do however good it looks.
//
//   A REPOSITORY IS NOT DEVELOPMENT. Existing and moving are separate
//   dimensions with separate states, and neither counts commits — a commit
//   total is a quality score with a technical name.
//
//   NO SCORE, NO ORDER. There is no number here to sort by, and no field a
//   caller could add up. Fundamentals answer "is something there", never "is
//   this a good buy".
// ---------------------------------------------------------------------------

import type { B20ClaimStandingV1 } from './launchContext.js';

export const B20_FUNDAMENTAL_DIMENSIONS_V1 = [
  'project_identity',
  'website',
  'product',
  'repository',
  'base_presence',
  'docs',
  'project_before_token',
  'development_activity',
] as const;

export type B20FundamentalDimensionV1 = (typeof B20_FUNDAMENTAL_DIMENSIONS_V1)[number];

/**
 * How a state was established. Never "inferred", never "assumed", and never a
 * model: an LLM may rephrase this bundle and may not contribute to it.
 */
export const B20_FUNDAMENTAL_PROVENANCES_V1 = [
  /** Read from the file the project serves on its own domain. */
  'domain_claim_file',
  /** An HTTPS request Miorail made to a declared URL, and what came back. */
  'https_probe',
  /** A functional call to a declared product endpoint — a real request whose
   * structured answer is the evidence, rather than a page that rendered. */
  'functional_probe',
  /** The repository host's own API. */
  'repository_api',
  /** A read of Base itself. */
  'onchain_read',
  /** Two stored timestamps compared. */
  'timestamp_comparison',
  /** Nothing was collected. The state is `unknown` and this says why. */
  'not_collected',
] as const;

export type B20FundamentalProvenanceV1 = (typeof B20_FUNDAMENTAL_PROVENANCES_V1)[number];

/**
 * Every state any dimension may take.
 *
 * One union rather than eight, so a caller cannot compare across dimensions by
 * accident and so an exhaustive copy table is possible. Which states a given
 * dimension may reach is decided by the projection below and asserted in tests.
 */
export const B20_FUNDAMENTAL_STATES_V1 = [
  'verified',
  'unverified',
  'live',
  'found',
  'active',
  'quiet',
  'yes',
  'no',
  'unknown',
] as const;

export type B20FundamentalStateV1 = (typeof B20_FUNDAMENTAL_STATES_V1)[number];

export interface B20FundamentalFindingV1 {
  dimension: B20FundamentalDimensionV1;
  state: B20FundamentalStateV1;
  /** How the state was established. */
  provenance: B20FundamentalProvenanceV1;
  /** When the evidence was collected. Null exactly when nothing was. */
  observedAt: string | null;
  /** What was looked at — a URL, a repository, a contract. Null when nothing
   * was. Never a credential, and never an endpoint Miorail was configured
   * with: only a reference the PROJECT published. */
  reference: string | null;
  /** The reader's word for the state. */
  label: string;
  /** What this state does not claim. Present on every finding, including the
   * positive ones — especially the positive ones. */
  note: string;
}

/**
 * The profile a surface renders.
 *
 * `identityVerified` is not a summary of the findings: it is the gate they all
 * hang from, and when it is false the findings list is EMPTY rather than a
 * column of `unknown`. A column of unknowns invites a reader to wonder what
 * would fill it in, when the honest answer is that nothing may be attached to
 * this token at all.
 */
export interface B20FundamentalProfileV1 {
  identityVerified: boolean;
  /** The domain the identity was proven against. Null when unverified. */
  projectDomain: string | null;
  /** Reader-facing: `Product-backed`, `Verified project`, `Unverified`. */
  standing: B20FundamentalStandingV1;
  headline: string;
  detail: string;
  findings: readonly B20FundamentalFindingV1[];
  /** Dimensions with nothing collected, named so a reader sees the whole
   * checklist rather than only what happened to pass. */
  missing: readonly B20FundamentalDimensionV1[];
}

/**
 * Three standings, and the ordering between them is a fact ordering rather than
 * a quality ordering: each one is the one below it plus one more proven thing.
 * Nothing sorts a feed by it.
 */
export const B20_FUNDAMENTAL_STANDINGS_V1 = ['product_backed', 'verified_project', 'unverified'] as const;
export type B20FundamentalStandingV1 = (typeof B20_FUNDAMENTAL_STANDINGS_V1)[number];

export const B20_FUNDAMENTAL_STANDING_COPY_V1: Readonly<
  Record<B20FundamentalStandingV1, { label: string; chip: string }>
> = {
  product_backed: { label: 'Product-backed · Project link verified', chip: 'Project-backed' },
  verified_project: { label: 'Project link verified', chip: 'Verified project' },
  unverified: { label: 'Unverified', chip: 'Project context unknown' },
};

export const B20_FUNDAMENTAL_DIMENSION_LABEL_V1: Readonly<Record<B20FundamentalDimensionV1, string>> = {
  project_identity: 'Project identity',
  website: 'Website',
  product: 'Product',
  repository: 'Repository',
  base_presence: 'Base presence',
  docs: 'Docs',
  project_before_token: 'Before token',
  development_activity: 'Development',
};

// ---------------------------------------------------------------------------
// The evidence a collector hands in.
//
// Every field is nullable and null means NOT COLLECTED. There is no field here
// a collector can use to say "I looked and there is nothing" — because for
// every dimension but one, those two are the same state as far as a reader
// should be concerned: Miorail did not establish it.
// ---------------------------------------------------------------------------

export interface B20ProbeV1 {
  /** The URL the project declared. */
  url: string;
  /** Whether the request completed with a success status. */
  reachable: boolean;
  observedAt: string;
}

export interface B20ProductProbeV1 extends B20ProbeV1 {
  /**
   * True only when the endpoint answered a real request with structured data.
   *
   * This is the whole difference between `live` and `found`. A landing page
   * returns a document; a product answers a call. Miorail makes the call.
   */
  functional: boolean;
}

export interface B20RepositoryEvidenceV1 {
  /** The repository the project declared, as a URL. */
  url: string;
  /** When the repository was created, from its host's API. Null when the host
   * did not report one. */
  createdAt: string | null;
  /** The most recent commit the host reported. Null when none was read — which
   * is not the same as a repository with no commits, and never becomes
   * `quiet`. */
  lastCommitAt: string | null;
  observedAt: string;
}

export interface B20BasePresenceEvidenceV1 {
  /** What was verified on Base. A contract Miorail read, or a Base surface that
   * answered. */
  kind: 'onchain_contract' | 'base_app_manifest' | 'mcp_endpoint';
  reference: string;
  observedAt: string;
}

export interface B20FundamentalEvidenceV1 {
  /** THE GATE. Nothing below is attached to a token unless this is verified. */
  claim: B20ClaimStandingV1;
  /** The domain the claim was made from and proven against. */
  claimantDomain: string | null;
  website: B20ProbeV1 | null;
  product: B20ProductProbeV1 | null;
  docs: B20ProbeV1 | null;
  repository: B20RepositoryEvidenceV1 | null;
  basePresence: B20BasePresenceEvidenceV1 | null;
  /** When the token was launched, from the chain. Null when the launch time is
   * unknown — in which case `project_before_token` stays `unknown` however old
   * the repository is. */
  launchedAt: string | null;
  /** Evaluation clock, for the activity window. */
  now: string;
}

/**
 * How recently a repository must have moved to be called active.
 *
 * Ninety days is deliberately generous. A shorter window would make a finished
 * project look abandoned, and "quiet" already refuses to mean anything more
 * than "no commit inside this window".
 */
export const B20_DEVELOPMENT_ACTIVE_WINDOW_DAYS_V1 = 90;

const DAY_MS_V1 = 24 * 60 * 60 * 1000;

function withinWindowV1(instant: string | null, now: string, days: number): boolean | null {
  if (instant === null) return null;
  const at = Date.parse(instant);
  const clock = Date.parse(now);
  if (!Number.isFinite(at) || !Number.isFinite(clock)) return null;
  return clock - at <= days * DAY_MS_V1;
}

/**
 * The words for one (dimension, state) pair.
 *
 * A table rather than inline strings because a profile is written once by a
 * collector and read back many times from stored rows, and those two paths must
 * say IDENTICAL things. Deriving the copy from the stored state on every read
 * is what makes that true by construction rather than by discipline — the API,
 * the MCP and the card all end up quoting this table.
 *
 * Every note bounds its own claim, including the positive ones.
 */
export const B20_FUNDAMENTAL_COPY_V1: Readonly<
  Record<string, { label: string; note: string }>
> = {
  'project_identity:verified': {
    label: 'Verified',
    note: 'Miorail checked the links between this token and the claiming domain and nothing else — it did not review the project, its team or its code.',
  },
  'website:verified': {
    label: 'Verified',
    note: 'The site the project declared answered a request. A reachable site is not a working product and says nothing about what the project does.',
  },
  'website:unverified': {
    label: 'Not verified',
    note: 'The declared site did not answer when Miorail asked. That may be a temporary failure at either end, and it is not evidence that the project is gone.',
  },
  'product:live': {
    label: 'Live',
    note: 'A declared product endpoint answered a real request with structured data. That is evidence the product runs — not that it is useful, correct, safe or maintained.',
  },
  'product:found': {
    label: 'Found',
    note: 'A declared product page was reachable and served a document. Miorail did not get a working answer out of it, so this is a page that exists rather than a product shown to run.',
  },
  'product:unknown': {
    label: 'Unknown',
    note: 'A product endpoint was declared and did not answer. Miorail establishes nothing from that in either direction.',
  },
  'repository:active': {
    label: 'Active',
    note: `The declared repository exists and its host reported a push inside the last ${B20_DEVELOPMENT_ACTIVE_WINDOW_DAYS_V1} days. Miorail counts no commits and reads no code — activity is not quality.`,
  },
  'repository:found': {
    label: 'Found',
    note: 'The declared repository exists. Miorail did not establish recent activity in it, which is not the same as establishing that there is none.',
  },
  'base_presence:verified': {
    label: 'Verified',
    note: 'A surface the project declared on Base answered, or a contract it declared exists. Presence is not endorsement by Base or by anyone else, and says nothing about what the code does.',
  },
  'docs:found': {
    label: 'Found',
    note: 'Documentation the project declared was reachable. Miorail did not read it and makes no claim about what it says.',
  },
  'docs:unknown': {
    label: 'Unknown',
    note: 'Declared documentation did not answer. Nothing is established from that.',
  },
  'project_before_token:yes': {
    label: 'Yes',
    note: 'The declared repository was created before this token launched. It establishes that work existed first, not that the token was part of it.',
  },
  'project_before_token:no': {
    label: 'No',
    note: 'The declared repository was created after this token launched. That is a comparison of two dates and nothing more — a project may predate any repository it happens to publish.',
  },
  'development_activity:active': {
    label: 'Active',
    note: `A push landed in the declared repository inside the last ${B20_DEVELOPMENT_ACTIVE_WINDOW_DAYS_V1} days. Miorail did not read what changed.`,
  },
  'development_activity:quiet': {
    label: 'Quiet',
    note: `No push landed in the declared repository inside the last ${B20_DEVELOPMENT_ACTIVE_WINDOW_DAYS_V1} days. Quiet is not abandoned, and Miorail reads one repository — work may be happening somewhere it cannot see.`,
  },
};

/** The copy key for a pair. Exported so a caller can assert coverage rather
 * than discovering a missing pair on a production card. */
export function fundamentalCopyKeyV1(
  dimension: B20FundamentalDimensionV1,
  state: B20FundamentalStateV1,
): string {
  return `${dimension}:${state}`;
}

function productBackedDetailV1(domain: string, verifiedLabel: string): string {
  return `This token is linked to ${domain} by ${verifiedLabel} verified checks, and a product endpoint that domain declared answered a real request. Nothing here is a statement about price, quality or what the project will do next.`;
}

function verifiedProjectDetailV1(domain: string, verifiedLabel: string): string {
  return `This token is linked to ${domain} by ${verifiedLabel} verified checks. Miorail did not establish a running product, which is not the same as establishing there is none. Nothing here is a statement about price or quality.`;
}

function findingV1(
  dimension: B20FundamentalDimensionV1,
  state: B20FundamentalStateV1,
  provenance: B20FundamentalProvenanceV1,
  observedAt: string | null,
  reference: string | null,
): B20FundamentalFindingV1 {
  const copy = B20_FUNDAMENTAL_COPY_V1[fundamentalCopyKeyV1(dimension, state)];
  // A pair with no copy is a programming error, and the honest fallback says
  // so rather than printing a raw state word on a consumer card.
  return {
    dimension,
    state,
    provenance,
    observedAt,
    reference,
    label: copy?.label ?? 'Unknown',
    note: copy?.note ?? 'Miorail has no reading for this dimension.',
  };
}

/**
 * The projection. Pure, total, and deterministic.
 *
 * Nothing here reaches the network, reads a database or calls a model. It maps
 * collected evidence onto states, which is exactly the part that has to be
 * testable without any of those.
 */
export function b20FundamentalProfileV1(evidence: B20FundamentalEvidenceV1): B20FundamentalProfileV1 {
  const verified = evidence.claim.status === 'verified' && evidence.claimantDomain !== null;

  if (!verified) {
    // The gate. No findings at all — not a column of `unknown`, which would
    // read as a project whose details Miorail merely has not got to yet.
    return {
      identityVerified: false,
      projectDomain: null,
      standing: 'unverified',
      headline: 'Project context — Unverified',
      detail:
        evidence.claim.status === 'refuted'
          ? 'A project claimed this token and a check contradicted the claim, so nothing is attached to it. This is a statement about that claim, not about the token.'
          : 'No project has proven a link to this token, so Miorail attaches no project information to it. Sharing a name or a symbol with a known project is not a link — most launches are never claimed, and that is the ordinary case rather than a warning.',
      findings: [],
      missing: B20_FUNDAMENTAL_DIMENSIONS_V1.filter((dimension) => dimension !== 'project_identity'),
    };
  }

  const domain = evidence.claimantDomain as string;
  const findings: B20FundamentalFindingV1[] = [
    findingV1('project_identity', 'verified', 'domain_claim_file', evidence.claim.lastCheckedAt ?? null, domain),
  ];

  // Website. `verified` means a page the PROJECT declared, on the domain the
  // claim was proven against, answered. It is not a statement about the page.
  if (evidence.website) {
    findings.push(
      findingV1(
        'website',
        evidence.website.reachable ? 'verified' : 'unverified',
        'https_probe',
        evidence.website.observedAt,
        evidence.website.url,
      ),
    );
  }

  // Product. The distinction this layer exists for.
  if (evidence.product) {
    findings.push(
      evidence.product.functional
        ? findingV1('product', 'live', 'functional_probe', evidence.product.observedAt, evidence.product.url)
        : findingV1(
            'product',
            evidence.product.reachable ? 'found' : 'unknown',
            'https_probe',
            evidence.product.observedAt,
            evidence.product.url,
          ),
    );
  }

  // Repository. Existing and moving are separate answers.
  const recentCommit = evidence.repository
    ? withinWindowV1(evidence.repository.lastCommitAt, evidence.now, B20_DEVELOPMENT_ACTIVE_WINDOW_DAYS_V1)
    : null;
  if (evidence.repository) {
    findings.push(
      findingV1(
        'repository',
        recentCommit === true ? 'active' : 'found',
        'repository_api',
        evidence.repository.observedAt,
        evidence.repository.url,
      ),
    );
  }

  if (evidence.basePresence) {
    findings.push(
      findingV1(
        'base_presence',
        'verified',
        evidence.basePresence.kind === 'onchain_contract' ? 'onchain_read' : 'functional_probe',
        evidence.basePresence.observedAt,
        evidence.basePresence.reference,
      ),
    );
  }

  if (evidence.docs) {
    findings.push(
      findingV1(
        'docs',
        evidence.docs.reachable ? 'found' : 'unknown',
        'https_probe',
        evidence.docs.observedAt,
        evidence.docs.url,
      ),
    );
  }

  // Project before token. The only dimension that may say `no`, and only with
  // two real timestamps: a repository creation date and a launch time.
  const createdAt = evidence.repository?.createdAt ?? null;
  const before =
    createdAt !== null && evidence.launchedAt !== null
      ? Date.parse(createdAt) < Date.parse(evidence.launchedAt)
      : null;
  if (before !== null) {
    findings.push(
      findingV1(
        'project_before_token',
        before ? 'yes' : 'no',
        'timestamp_comparison',
        evidence.repository?.observedAt ?? null,
        evidence.repository?.url ?? null,
      ),
    );
  }

  if (recentCommit !== null) {
    findings.push(
      findingV1(
        'development_activity',
        recentCommit ? 'active' : 'quiet',
        'repository_api',
        evidence.repository?.observedAt ?? null,
        evidence.repository?.url ?? null,
      ),
    );
  }

  const present = new Set(findings.map((finding) => finding.dimension));
  const missing = B20_FUNDAMENTAL_DIMENSIONS_V1.filter((dimension) => !present.has(dimension));

  // Product-backed requires a product SHOWN TO RUN. A reachable page is not it,
  // which is what keeps the strongest standing from being reachable by
  // publishing a landing page.
  const productLive = findings.some(
    (finding) => finding.dimension === 'product' && finding.state === 'live',
  );
  const standing: B20FundamentalStandingV1 = productLive ? 'product_backed' : 'verified_project';

  return {
    identityVerified: true,
    projectDomain: domain,
    standing,
    headline: `Project context — ${domain}`,
    detail: productLive
      ? productBackedDetailV1(domain, evidence.claim.verifiedLabel)
      : verifiedProjectDetailV1(domain, evidence.claim.verifiedLabel),
    findings,
    missing,
  };
}

/**
 * The Discover filter. Three buckets, and the third is not a failing grade —
 * it is where almost every launch on this chain belongs.
 */
export const B20_PROJECT_FILTERS_V1 = ['all', 'product_backed', 'verified_project', 'unknown'] as const;
export type B20ProjectFilterV1 = (typeof B20_PROJECT_FILTERS_V1)[number];

export const B20_PROJECT_FILTER_COPY_V1: Readonly<Record<B20ProjectFilterV1, string>> = {
  all: 'Any project context',
  product_backed: 'Project-backed',
  verified_project: 'Verified project',
  unknown: 'Project context unknown',
};

/** Whether a profile belongs in a filtered view. `verified_project` includes
 * product-backed launches: a product-backed one is a verified one that proved
 * one more thing, and hiding it from the wider filter would be a surprise. */
export function b20ProjectFilterMatchesV1(
  filter: B20ProjectFilterV1,
  standing: B20FundamentalStandingV1,
): boolean {
  if (filter === 'all') return true;
  if (filter === 'unknown') return standing === 'unverified';
  if (filter === 'verified_project') return standing !== 'unverified';
  return standing === 'product_backed';
}

// ---------------------------------------------------------------------------
// Predicates — the questions a console may ask of the claimed corpus.
//
// A predicate is a DIMENSION plus the set of states that satisfy it. A set and
// not a single state, because the states of one dimension are not independent:
// a repository whose host reported a recent push is `active`, and a reader
// asking "which projects have a repository" means that one too. Writing the
// satisfying states out is what stops `repository_found` quietly excluding
// every repository that is being worked on.
//
// Two rules bound the whole table, and both exist because a predicate is
// ultimately a WHERE clause, and a WHERE clause silently turns "no row" into
// "excluded":
//
//   EVERY PREDICATE IS POSITIVE. There is no `no_product` and there never may
//   be. Miorail can prove that a declared product answered; it cannot prove
//   that a project has none, because it only ever probes what a project itself
//   declared. A negative predicate would publish "Miorail did not look" as
//   "there is nothing there" — asserted below and pinned by a test.
//
//   THE DENOMINATOR IS THE CLAIMED CORPUS. A match count is only meaningful
//   against the number of VERIFIED CLAIMS, never against the launch universe.
//   28,000 launches were not checked and failed; they were never in the
//   corpus, and the answer has to say so in those words.
// ---------------------------------------------------------------------------

export const B20_FUNDAMENTAL_PREDICATES_V1 = [
  'verified_project',
  'verified_website',
  'live_product',
  'verified_base_presence',
  'repository_found',
  'docs_found',
  'development_active',
  'project_before_token',
] as const;

export type B20FundamentalPredicateV1 = (typeof B20_FUNDAMENTAL_PREDICATES_V1)[number];

/**
 * States that assert an ABSENCE rather than a presence.
 *
 * No predicate may be satisfied by one of these. `unknown` is the absence of a
 * row; `unverified`, `quiet` and `no` are all readings that a reader would take
 * as a verdict on the project when they are readings of what Miorail could
 * reach. Exported so the rule is testable rather than a comment.
 */
export const B20_FUNDAMENTAL_ABSENCE_STATES_V1 = ['unknown', 'unverified', 'quiet', 'no'] as const;

export interface B20FundamentalPredicateRuleV1 {
  /**
   * The evidence dimension this predicate reads, or null when it reads the
   * CLAIM itself rather than a finding hanging off one.
   *
   * Only `verified_project` is null: it asks whether the gate opened at all,
   * which is a property of the claim and true even for a claim whose probes all
   * came back empty.
   */
  dimension: B20FundamentalDimensionV1 | null;
  /** Every state that satisfies the predicate. Never an absence state. */
  states: readonly B20FundamentalStateV1[];
  /** What the reader asked for, in their words. */
  label: string;
  /** What a match establishes — and, the half that carries the weight, what a
   * NON-match does not. */
  note: string;
}

export const B20_FUNDAMENTAL_PREDICATE_RULES_V1: Readonly<
  Record<B20FundamentalPredicateV1, B20FundamentalPredicateRuleV1>
> = {
  verified_project: {
    dimension: null,
    states: [],
    label: 'a verified project link',
    note: 'A verified link means Miorail checked who published the token against a domain that claimed it. It is not a review of the project, and a launch with no claim was never checked rather than checked and rejected.',
  },
  verified_website: {
    dimension: 'website',
    states: ['verified'],
    label: 'a verified website',
    note: 'The site the project declared answered a request. A reachable site is not a working product, and a project whose site is absent from this list may simply never have declared one.',
  },
  live_product: {
    dimension: 'product',
    states: ['live'],
    label: 'a live product',
    note: 'A declared product endpoint answered a real request with structured data. That is evidence the product runs — not that it is useful, correct, safe or maintained. A project not listed here has no product Miorail got an answer out of, which is not the same as having none.',
  },
  verified_base_presence: {
    dimension: 'base_presence',
    states: ['verified'],
    label: 'a verified presence on Base',
    note: 'A surface the project declared on Base answered, or a contract it declared exists. Presence is not endorsement by Base or anyone else.',
  },
  repository_found: {
    // `active` is a repository that also moved recently. A reader asking which
    // projects have a repository means those too, and a predicate that excluded
    // them would drop precisely the ones being worked on.
    dimension: 'repository',
    states: ['found', 'active'],
    label: 'a repository',
    note: 'The repository the project declared exists on its host. Miorail read no code and counted no commits. A private repository answers nothing, so a project missing here may still have one.',
  },
  docs_found: {
    dimension: 'docs',
    states: ['found'],
    label: 'documentation',
    note: 'Documentation the project declared was reachable. Miorail did not read it and makes no claim about what it says.',
  },
  development_active: {
    dimension: 'development_activity',
    states: ['active'],
    label: `a push inside the last ${B20_DEVELOPMENT_ACTIVE_WINDOW_DAYS_V1} days`,
    note: `A push landed in the declared repository inside the last ${B20_DEVELOPMENT_ACTIVE_WINDOW_DAYS_V1} days. Miorail did not read what changed, and a project absent from this list may be working somewhere Miorail cannot see.`,
  },
  project_before_token: {
    dimension: 'project_before_token',
    states: ['yes'],
    label: 'work that predates the token',
    note: 'The declared repository was created before this token launched. It establishes that work existed first, not that the token was part of it.',
  },
};

/** Whether a predicate is expressed only in states that assert presence. True
 * for every rule above, and a test holds it that way. */
export function b20PredicateIsPositiveV1(predicate: B20FundamentalPredicateV1): boolean {
  const rule = B20_FUNDAMENTAL_PREDICATE_RULES_V1[predicate];
  const absence: readonly string[] = B20_FUNDAMENTAL_ABSENCE_STATES_V1;
  return rule.states.every((state) => !absence.includes(state));
}

/**
 * Whether a profile satisfies a predicate.
 *
 * Pure, and deliberately re-applied after the storage read even though the
 * query already filtered: a profile whose claim is not verified carries NO
 * findings at all, so re-checking here is what makes an evidence row orphaned
 * by a downgraded claim unable to answer a question. Cheap, and it is the lock
 * that does not depend on a JOIN being written correctly.
 */
export function b20PredicateMatchesProfileV1(
  predicate: B20FundamentalPredicateV1,
  profile: B20FundamentalProfileV1,
): boolean {
  if (!profile.identityVerified) return false;
  const rule = B20_FUNDAMENTAL_PREDICATE_RULES_V1[predicate];
  if (rule.dimension === null) return true;
  return profile.findings.some(
    (finding) => finding.dimension === rule.dimension && rule.states.includes(finding.state),
  );
}

/** The finding a match was made on, for an answer that has to show its
 * evidence. Null for `verified_project`, whose evidence is the claim itself. */
export function b20PredicateFindingV1(
  predicate: B20FundamentalPredicateV1,
  profile: B20FundamentalProfileV1,
): B20FundamentalFindingV1 | null {
  const rule = B20_FUNDAMENTAL_PREDICATE_RULES_V1[predicate];
  if (rule.dimension === null) return null;
  return (
    profile.findings.find(
      (finding) => finding.dimension === rule.dimension && rule.states.includes(finding.state),
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// The read path.
//
// A profile is written once by a collector and read back on every card, so the
// two have to say identical things. They do, because both build the envelope
// here and both take their words from `B20_FUNDAMENTAL_COPY_V1` — the only
// difference is that the collector DECIDES the states from probes and this
// reads them back from rows.
// ---------------------------------------------------------------------------

export interface B20StoredFundamentalV1 {
  dimension: B20FundamentalDimensionV1;
  state: B20FundamentalStateV1;
  provenance: B20FundamentalProvenanceV1;
  reference: string | null;
  observedAt: string;
}

/**
 * Rebuilds a profile from a stored claim and its evidence rows.
 *
 * The claim decides the gate exactly as it does on the write path: rows for a
 * token whose claim is not verified produce the unverified profile and are
 * DROPPED rather than rendered. The storage layer refuses to write that
 * combination at all, so this is the second of two locks on the same door.
 */
export function b20FundamentalProfileFromStoredV1(input: {
  claim: B20ClaimStandingV1;
  claimantDomain: string | null;
  rows: readonly B20StoredFundamentalV1[];
}): B20FundamentalProfileV1 {
  const gate = b20FundamentalProfileV1({
    claim: input.claim,
    claimantDomain: input.claimantDomain,
    website: null,
    product: null,
    docs: null,
    repository: null,
    basePresence: null,
    launchedAt: null,
    now: new Date(0).toISOString(),
  });
  if (!gate.identityVerified) return gate;

  const order = new Map(B20_FUNDAMENTAL_DIMENSIONS_V1.map((dimension, index) => [dimension, index]));
  const findings = [...input.rows]
    .sort((left, right) => (order.get(left.dimension) ?? 0) - (order.get(right.dimension) ?? 0))
    .map((row) => findingV1(row.dimension, row.state, row.provenance, row.observedAt, row.reference));

  const present = new Set(findings.map((finding) => finding.dimension));
  const productLive = findings.some(
    (finding) => finding.dimension === 'product' && finding.state === 'live',
  );

  return {
    ...gate,
    standing: productLive ? 'product_backed' : 'verified_project',
    detail: productLive ? productBackedDetailV1(gate.projectDomain!, input.claim.verifiedLabel) : gate.detail,
    findings,
    missing: B20_FUNDAMENTAL_DIMENSIONS_V1.filter((dimension) => !present.has(dimension)),
  };
}

/**
 * Which findings a collapsed card shows.
 *
 * Four at most, in a fixed order chosen for what a reader asked — "is there a
 * product, is anyone working on it, is it on Base, did it exist first" — with
 * the remainder falling back in a stated order rather than by whatever the
 * storage returned. Identity is not among them: it is the chip above, and
 * repeating it as a row would spend one of four slots saying what the header
 * already said.
 *
 * This is a display order, not a ranking. It is the same for every token.
 */
export const B20_FUNDAMENTAL_HIGHLIGHT_ORDER_V1 = [
  'product',
  'development_activity',
  'base_presence',
  'project_before_token',
  'website',
  'repository',
  'docs',
] as const;

export const B20_FUNDAMENTAL_HIGHLIGHT_LIMIT_V1 = 4;

export function b20FundamentalHighlightsV1(
  profile: B20FundamentalProfileV1,
): readonly B20FundamentalFindingV1[] {
  if (!profile.identityVerified) return [];
  const byDimension = new Map(profile.findings.map((finding) => [finding.dimension, finding]));
  const chosen: B20FundamentalFindingV1[] = [];
  for (const dimension of B20_FUNDAMENTAL_HIGHLIGHT_ORDER_V1) {
    const finding = byDimension.get(dimension);
    if (finding) chosen.push(finding);
    if (chosen.length === B20_FUNDAMENTAL_HIGHLIGHT_LIMIT_V1) break;
  }
  return chosen;
}
