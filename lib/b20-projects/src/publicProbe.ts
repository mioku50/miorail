import type {
  B20PublicContextCandidateV1,
  B20PublicContextEvidenceV1,
} from '@mioagent/opportunity-rail';

import type { B20HttpFetchV1 } from './collect.js';
import {
  B20_SEARCH_CANDIDATE_LIMIT_V1,
  classifyCandidateV1,
  type B20PublicSearchResultV1,
} from './publicSearch.js';

// ---------------------------------------------------------------------------
// Establishing the grounds ourselves.
//
// The search says where to look. Everything a card then states, this file read
// with its own request — which is what keeps the model out of the evidence
// entirely: it contributed URLs, and not one fact.
//
// The fetch is the SAME guarded one the verified layer uses: HTTPS only, no
// private or loopback host before the request or after any redirect, capped
// redirects, time and body, and not one Miorail header. That matters more here
// than it does there. A claim file's URLs came from a domain the project
// controls; these came from a search engine, which means an attacker who can
// rank a page can choose what Miorail fetches.
//
// Nothing here decides a state. Each function reports what came back and the
// pure projection turns records into words — the same split as the verified
// layer, and the reason "unknown never becomes no" is enforceable rather than
// merely intended.
// ---------------------------------------------------------------------------

export interface B20PublicProbeDepsV1 {
  http: B20HttpFetchV1;
  now: () => string;
}

/** Bounded so one probe pass cannot spend an unbounded number of requests. */
export const B20_PUBLIC_PROBE_FETCH_LIMIT_V1 = 4;

/**
 * Whether a fetched page contains this exact address.
 *
 * The strongest ground on the card, so it is the strictest test here: the whole
 * 20-byte address, case-insensitively, and nothing shorter. A prefix match
 * would be met by every B20 token at once — they all begin `0xb2000000…`.
 */
export function pageNamesAddressV1(bodyText: string, tokenAddress: string): boolean {
  const wanted = tokenAddress.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(wanted)) return false;
  return bodyText.toLowerCase().includes(wanted);
}

/**
 * Every https URL in a page that points at one of `hosts`.
 *
 * Deliberately a scan of the raw text rather than a parse: a project's links
 * live in anchors, in JSON-LD, in a meta tag and in a script-rendered footer,
 * and a link is a link wherever it sits. The cost of the loose reading is
 * bounded by what it is used for — the presence of a link, never its meaning.
 */
export function linksToHostsV1(bodyText: string, hosts: readonly string[]): string[] {
  const found: string[] = [];
  const pattern = /https:\/\/[^\s"'<>)\]]+/g;
  for (const match of bodyText.matchAll(pattern)) {
    const url = match[0].replace(/[.,;]+$/, '');
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      continue;
    }
    if (hosts.includes(host) && !found.includes(url)) found.push(url);
    if (found.length >= 10) break;
  }
  return found;
}

/** Whether a page links back to this host, in either www form. */
export function linksBackToHostV1(bodyText: string, host: string): string | null {
  const wanted = host.toLowerCase().replace(/^www\./, '');
  return linksToHostsV1(bodyText, [wanted])[0] ?? null;
}

/**
 * Search results turned into the candidates worth fetching.
 *
 * Unclassifiable results are dropped, not carried as "other": a block explorer
 * is about this token and is not the project, and a card offering it as a
 * possible website would be wrong about every launch on the chain.
 */
export function candidatesFromSearchV1(
  results: readonly B20PublicSearchResultV1[],
): B20PublicContextCandidateV1[] {
  const candidates: B20PublicContextCandidateV1[] = [];
  const seenHosts = new Set<string>();
  for (const result of results) {
    const kind = classifyCandidateV1(result.url);
    if (kind === null) continue;
    let host: string;
    try {
      host = new URL(result.url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      continue;
    }
    // One candidate per host. A search returns five pages of one site, and
    // fetching all of them proves nothing five times.
    const key = `${kind}:${host}`;
    if (seenHosts.has(key)) continue;
    seenHosts.add(key);
    candidates.push({ kind, url: result.url, host, origin: 'search_result', fetched: false });
    if (candidates.length >= B20_SEARCH_CANDIDATE_LIMIT_V1) break;
  }
  return candidates;
}

async function readPageV1(
  http: B20HttpFetchV1,
  url: string,
): Promise<string | null> {
  try {
    const response = await http({ url, accept: 'text/html,application/json;q=0.9,*/*;q=0.8' });
    return response.ok ? response.bodyText : null;
  } catch {
    // A refused or failed probe leaves every ground that depended on it
    // `unchecked`. It is never an `absent`, which would be a claim about the
    // page rather than about the request.
    return null;
  }
}

/**
 * One probe pass over the candidates a search produced.
 *
 * The website is fetched first and is the anchor: the repository and social
 * grounds are about whether the accounts point AT EACH OTHER, so without a site
 * to point back to there is nothing to establish and they stay `unchecked`.
 */
export async function probePublicContextV1(input: {
  chainId: number;
  tokenAddress: string;
  candidates: readonly B20PublicContextCandidateV1[];
  deps: B20PublicProbeDepsV1;
}): Promise<B20PublicContextEvidenceV1> {
  const { deps } = input;
  const observedAt = deps.now();
  const candidates = input.candidates.map((candidate) => ({ ...candidate }));

  const website = candidates.find((candidate) => candidate.kind === 'website') ?? null;
  const repository = candidates.find((candidate) => candidate.kind === 'repository') ?? null;
  const social = candidates.find((candidate) => candidate.kind === 'social') ?? null;

  let fetches = 0;
  const budgeted = async (url: string): Promise<string | null> => {
    if (fetches >= B20_PUBLIC_PROBE_FETCH_LIMIT_V1) return null;
    fetches += 1;
    return readPageV1(deps.http, url);
  };

  const evidence: B20PublicContextEvidenceV1 = {
    chainId: input.chainId,
    tokenAddress: input.tokenAddress.toLowerCase(),
    candidates,
    pageNamesToken: null,
    siteLinksRepository: null,
    repositoryLinksSite: null,
    siteLinksSocial: null,
    socialLinksSite: null,
    observedAt,
  };

  const siteBody = website ? await budgeted(website.url) : null;
  if (website && siteBody !== null) {
    website.fetched = true;
    evidence.pageNamesToken = {
      found: pageNamesAddressV1(siteBody, input.tokenAddress),
      reference: website.url,
    };
    const repoLinks = linksToHostsV1(siteBody, ['github.com']);
    evidence.siteLinksRepository = { found: repoLinks.length > 0, reference: repoLinks[0] ?? null };
    const socialLinks = linksToHostsV1(siteBody, ['x.com', 'twitter.com']);
    evidence.siteLinksSocial = { found: socialLinks.length > 0, reference: socialLinks[0] ?? null };
  }

  // The back-links. Only worth a request when there is a site host to look for:
  // "does this repository mention some website" is not a ground.
  if (website && repository) {
    const repoBody = await budgeted(repository.url);
    if (repoBody !== null) {
      repository.fetched = true;
      const back = linksBackToHostV1(repoBody, website.host);
      evidence.repositoryLinksSite = { found: back !== null, reference: back };
      // A repository page that names the token is the same ground as a website
      // that does, and it is worth keeping when the site did not.
      if (evidence.pageNamesToken?.found !== true && pageNamesAddressV1(repoBody, input.tokenAddress)) {
        evidence.pageNamesToken = { found: true, reference: repository.url };
      }
    }
  }

  if (website && social) {
    const socialBody = await budgeted(social.url);
    if (socialBody !== null) {
      social.fetched = true;
      const back = linksBackToHostV1(socialBody, website.host);
      evidence.socialLinksSite = { found: back !== null, reference: back };
    }
  }

  return evidence;
}
