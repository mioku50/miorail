import {
  b20PublicContextV1,
  type B20PublicContextLookupV1,
  type B20PublicContextV1,
} from '@mioagent/opportunity-rail';
import {
  B20_PROBE_TIMEOUT_MS_V1,
  candidatesFromSearchV1,
  suppliedDomainCandidateV1,
  type B20SuppliedDomainRefusalV1,
  createB20HttpFetchV1,
  createMistralPublicSearchV1,
  probePublicContextV1,
  publicSearchQueryV1,
  widenedSearchQueryV1,
  type B20PublicSearchV1,
} from '@mioagent/b20-projects';

// ---------------------------------------------------------------------------
// Unverified public context, on request.
//
// ON REQUEST is the design, not an optimisation. Scanning 33,541 launches would
// cost a search and up to four fetches each, and would manufacture a candidate
// for every launch that shares a name with something famous — which is 61.7% of
// them by symbol alone. A reader asking about one token is the only signal that
// makes the question worth answering, and it keeps the false links to the ones
// somebody actually looked at.
//
// The pass never touches the claim tables. It cannot: the projection it calls
// has no branch that returns a fundamental standing, and this module imports
// none of that vocabulary. A candidate has no path into `verified`.
// ---------------------------------------------------------------------------

/** One answer is worth keeping for a while: a project's site does not change in
 * a minute, and a reader who reloads should not spend a second search. */
export const PUBLIC_CONTEXT_CACHE_MS_V1 = 30 * 60 * 1000;

export interface B20PublicContextDepsV1 {
  search: B20PublicSearchV1;
  now: () => Date;
}

const cacheV1 = new Map<string, { at: number; value: B20PublicContextV1 }>();

/** Test seam and operator escape hatch. */
export function clearB20PublicContextCacheV1(): void {
  cacheV1.clear();
}

/**
 * Whether this server can answer at all.
 *
 * A missing key is NOT an empty result: "nothing was found" and "this server
 * cannot look" are different sentences, and only the first is about the token.
 */
export function b20PublicContextSearchFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): B20PublicSearchV1 | null {
  const baseUrl = (env.B20_PUBLIC_SEARCH_BASE_URL || 'https://api.mistral.ai').trim();
  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    return null;
  }
  // A bearer credential belongs to one host. `LLM_API_KEY` is currently a
  // TokenForge key and must never be used against Mistral merely because this
  // older feature defaults to api.mistral.ai.
  const apiKey = (
    env.B20_PUBLIC_SEARCH_API_KEY ||
    (host === 'api.mistral.ai' ? env.MISTRAL_API_KEY : '') ||
    ''
  ).trim();
  const model = (env.B20_PUBLIC_SEARCH_MODEL || '').trim();
  if (!apiKey) return null;
  return createMistralPublicSearchV1({
    apiKey,
    baseUrl,
    ...(model ? { model } : {}),
    timeoutMs: 30_000,
  });
}

/** A caller named a domain Miorail will not fetch. Distinct from an empty
 * answer: nothing was looked at, so nothing can be said. */
export class B20SuppliedDomainRefusedError extends Error {
  readonly refusal: B20SuppliedDomainRefusalV1;
  constructor(refusal: B20SuppliedDomainRefusalV1) {
    super(`supplied domain refused: ${refusal}`);
    this.name = 'B20SuppliedDomainRefusedError';
    this.refusal = refusal;
  }
}

export async function readB20PublicContextV1(input: {
  chainId: number;
  tokenAddress: string;
  symbol: string | null;
  name: string | null;
  /**
   * A domain the reader named.
   *
   * When present NO SEARCH RUNS. A person naming `orbitlab.xyz` has supplied
   * the one thing a search cannot — which domain to look at — and spending a
   * metered search to rank pages they did not ask about would be answering a
   * different question. Miorail believes the domain no more than it believes
   * a ranked result: it fetches it and looks for this token's address.
   */
  domain?: string | null;
  deps: B20PublicContextDepsV1;
}): Promise<B20PublicContextV1> {
  const tokenAddress = input.tokenAddress.toLowerCase();
  const now = input.deps.now();
  const supplied = input.domain ? suppliedDomainCandidateV1(input.domain) : null;
  if (supplied && !supplied.ok) throw new B20SuppliedDomainRefusedError(supplied.refusal);
  const key = `${input.chainId}:${tokenAddress}:${supplied?.ok ? supplied.host : ''}`;
  const cached = cacheV1.get(key);
  if (cached && now.getTime() - cached.at < PUBLIC_CONTEXT_CACHE_MS_V1) return cached.value;

  let candidates;
  let lookup: B20PublicContextLookupV1;
  if (supplied?.ok) {
    // The named domain is the whole starting point. Its repository and
    // social accounts are discovered from the site's own links, which is
    // better evidence than a ranking: a link in the project's own footer is
    // the project saying which accounts are theirs.
    candidates = [
      {
        kind: 'website' as const,
        url: supplied.url,
        host: supplied.host,
        origin: 'operator_supplied' as const,
        fetched: false,
      },
    ];
    // The domain was named, so obtaining a candidate cannot fail. Whether the
    // PAGE could be fetched is a separate fact the probe records.
    lookup = { kind: 'supplied_domain', completed: true, suppliedDomain: supplied.host };
  } else {
    const query = publicSearchQueryV1({ tokenAddress, symbol: input.symbol, name: input.name });
    // A search that FAILED and a search that completed and returned nothing are
    // different facts, and only the second is about the token. A timeout, a 429
    // or a 500 used to become "a public search returned nothing", which is
    // Miorail's failure wearing a token's name.
    let results: Awaited<ReturnType<B20PublicSearchV1>> = [];
    let completed = true;
    try {
      results = await input.deps.search(query);
    } catch {
      completed = false;
    }
    candidates = candidatesFromSearchV1(results);
    lookup = { kind: 'search', completed };

    // The fallback, and only when the precise query found NOTHING usable. A
    // widened search asks about the name, which identifies almost nothing on
    // this chain — so it never runs alongside a result that came from the
    // address, and the card says the search was widened when it does.
    //
    // Widening changes no ground: a page found this way still has to carry
    // this token's address to establish anything.
    if (completed && candidates.length === 0) {
      const widened = widenedSearchQueryV1({ symbol: input.symbol, name: input.name });
      if (widened !== null) {
        let widenedResults: Awaited<ReturnType<B20PublicSearchV1>> = [];
        let widenedCompleted = true;
        try {
          widenedResults = await input.deps.search(widened);
        } catch {
          widenedCompleted = false;
        }
        const found = candidatesFromSearchV1(widenedResults).map((candidate) => ({
          ...candidate,
          origin: 'symbol_search' as const,
        }));
        if (found.length > 0) {
          candidates = found;
          lookup = { kind: 'search', completed: widenedCompleted, widenedToSymbol: true };
        } else if (!widenedCompleted) {
          // The precise search completed and found nothing; the widened one
          // failed. "Found nothing" is still the honest headline, so the
          // completed flag stays true and only the log loses a line.
          lookup = { kind: 'search', completed: true };
        }
      }
    }
  }

  const evidence = await probePublicContextV1({
    chainId: input.chainId,
    tokenAddress,
    lookup,
    candidates,
    deps: {
      // The SAME guarded fetch the verified layer uses. It matters more here:
      // these URLs came from a search engine, so whoever can rank a page can
      // choose what Miorail fetches.
      http: createB20HttpFetchV1(),
      now: () => now.toISOString(),
    },
  });

  const value = b20PublicContextV1(evidence);
  cacheV1.set(key, { at: now.getTime(), value });
  return value;
}

export { B20_PROBE_TIMEOUT_MS_V1 };
