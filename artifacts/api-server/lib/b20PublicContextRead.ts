import {
  b20PublicContextV1,
  type B20PublicContextV1,
} from '@mioagent/opportunity-rail';
import {
  B20_PROBE_TIMEOUT_MS_V1,
  candidatesFromSearchV1,
  createB20HttpFetchV1,
  createMistralPublicSearchV1,
  probePublicContextV1,
  publicSearchQueryV1,
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
  const apiKey = (env.B20_PUBLIC_SEARCH_API_KEY || env.LLM_API_KEY || '').trim();
  const baseUrl = (env.B20_PUBLIC_SEARCH_BASE_URL || 'https://api.mistral.ai').trim();
  const model = (env.B20_PUBLIC_SEARCH_MODEL || '').trim();
  if (!apiKey) return null;
  return createMistralPublicSearchV1({
    apiKey,
    baseUrl,
    ...(model ? { model } : {}),
    timeoutMs: 30_000,
  });
}

export async function readB20PublicContextV1(input: {
  chainId: number;
  tokenAddress: string;
  symbol: string | null;
  name: string | null;
  deps: B20PublicContextDepsV1;
}): Promise<B20PublicContextV1> {
  const tokenAddress = input.tokenAddress.toLowerCase();
  const now = input.deps.now();
  const key = `${input.chainId}:${tokenAddress}`;
  const cached = cacheV1.get(key);
  if (cached && now.getTime() - cached.at < PUBLIC_CONTEXT_CACHE_MS_V1) return cached.value;

  const query = publicSearchQueryV1({ tokenAddress, symbol: input.symbol, name: input.name });
  // A search that fails is an absence. The projection then says the sentence
  // about the search rather than one about the token.
  let results: Awaited<ReturnType<B20PublicSearchV1>>;
  try {
    results = await input.deps.search(query);
  } catch {
    results = [];
  }

  const evidence = await probePublicContextV1({
    chainId: input.chainId,
    tokenAddress,
    candidates: candidatesFromSearchV1(results),
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
