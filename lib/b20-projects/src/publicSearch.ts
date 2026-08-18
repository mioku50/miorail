import type { B20PublicContextSourceKindV1 } from '@mioagent/opportunity-rail';

import { isNonPublicHostV1 } from './claimFile.js';

// ---------------------------------------------------------------------------
// Candidates, from a public search.
//
// The rule this file exists to enforce: URLs come out of the search engine's
// STRUCTURED result, never out of the model's prose. A model asked "what is the
// site for X" answers with a plausible domain whether or not it looked — that
// is measurable, not theoretical: OpenRouter's web plugin returned
// `aerodrome.finance` with no citations, no annotations and no search line in
// its usage. Correct, and produced from memory. For a token nobody has heard of
// the same machinery produces a domain that may not exist, and nothing in the
// answer distinguishes the two cases.
//
// So a search that returns no structured results is an ABSENCE here, never an
// answer. There is no code path from generated text to a candidate.
//
// The second rule is about the query. A B20 launch's `name` and `symbol` are
// written by whoever deployed it, so they are untrusted input; putting them
// verbatim into a request to a third party lets a deployer choose what Miorail
// asks the internet. They are sanitised and bounded here, and the ADDRESS leads
// the query because it is the only field that identifies one launch: 61.7% of
// canonical B20 symbols are shared with another launch.
// ---------------------------------------------------------------------------

export interface B20PublicSearchResultV1 {
  url: string;
  title: string | null;
  /** The engine's own ordering. Carried, never turned into a score. */
  rank: number | null;
  /** Which engine produced it, when the provider says. */
  source: string | null;
}

/** Injected so tests never reach the network and so the host owns the timeout. */
export type B20PublicSearchV1 = (query: string) => Promise<B20PublicSearchResultV1[]>;

/** Length bound on anything a deployer wrote that reaches a third party. */
export const B20_SEARCH_TERM_LIMIT_V1 = 48;
/** How many structured results are worth probing. Each one costs a fetch. */
export const B20_SEARCH_CANDIDATE_LIMIT_V1 = 6;

/**
 * A launch-supplied name or symbol, made safe to put in a query.
 *
 * Control characters and quotes go, length is bounded, and anything left
 * without a letter or digit is dropped entirely — a symbol of `"""` is not a
 * search term, and sending it would only ever return noise.
 */
export function searchTermV1(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/["'`\\<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, B20_SEARCH_TERM_LIMIT_V1)
    .trim();
  if (cleaned.length === 0) return null;
  return /\p{L}|\p{N}/u.test(cleaned) ? cleaned : null;
}

/**
 * The question Miorail asks the internet.
 *
 * The address leads it. A query built from the symbol alone would ask about
 * `b20`, which 950 launches call themselves, and the top result would belong to
 * whichever of them the web knows best.
 */
export function publicSearchQueryV1(input: {
  tokenAddress: string;
  symbol?: string | null;
  name?: string | null;
}): string {
  const terms = [input.tokenAddress.toLowerCase()];
  const symbol = searchTermV1(input.symbol);
  const name = searchTermV1(input.name);
  if (symbol) terms.push(symbol);
  // Only when it adds something. Most launches set name and symbol to the same
  // string, and repeating it narrows nothing.
  if (name && name.toLowerCase() !== (symbol ?? '').toLowerCase()) terms.push(name);
  return `${terms.join(' ')} official website github x.com`;
}

/**
 * A domain a person typed, made into a candidate — or refused.
 *
 * This is the better half of the layer and the cheaper one. A search has to
 * guess which of the web's pages is about a token nobody has indexed; a person
 * naming `orbitlab.xyz` has supplied the one thing the search cannot: which
 * domain to believe is the project's. Miorail still believes nothing — it
 * fetches that domain and looks for this token's address, exactly as it would
 * for a ranked result.
 *
 * Refused rather than repaired. A scheme, a path, a port or a private host is
 * somebody asking for something other than "look at this project's site", and
 * quietly stripping the parts that do not fit would be answering a question
 * nobody asked.
 */
export type B20SuppliedDomainRefusalV1 =
  | 'not_a_bare_domain'
  | 'non_public_host'
  | 'excluded_host';

export function suppliedDomainCandidateV1(
  raw: string,
): { ok: true; host: string; url: string } | { ok: false; refusal: B20SuppliedDomainRefusalV1 } {
  const value = String(raw ?? '').trim().toLowerCase().replace(/\.$/, '');
  // A bare hostname: labels, dots, at least one dot, nothing else. No scheme,
  // no path, no port, no credentials, no query.
  if (!/^(?=.{4,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(value)) {
    return { ok: false, refusal: 'not_a_bare_domain' };
  }
  if (isNonPublicHostV1(value)) return { ok: false, refusal: 'non_public_host' };
  const bare = value.replace(/^www\./, '');
  // The same list a ranked result is measured against. A person naming
  // basescan.org is naming a token explorer, not a project.
  if (EXCLUDED_HOSTS_V1.some((excluded) => bare === excluded || bare.endsWith(`.${excluded}`))) {
    return { ok: false, refusal: 'excluded_host' };
  }
  return { ok: true, host: bare, url: `https://${value}/` };
}

const SOCIAL_HOSTS_V1: readonly string[] = ['x.com', 'twitter.com'];
const REPOSITORY_HOSTS_V1: readonly string[] = ['github.com'];

/**
 * What kind of account a URL is, or null.
 *
 * Null is a real answer and the common one: a search for a token address
 * returns block explorers, aggregators and scam mirrors, and none of those is a
 * project account. A candidate this cannot classify is dropped rather than
 * shown under a guessed label.
 */
export function classifyCandidateV1(url: string): B20PublicContextSourceKindV1 | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (REPOSITORY_HOSTS_V1.includes(host)) return 'repository';
  if (SOCIAL_HOSTS_V1.includes(host)) return 'social';
  // Everything else is a website candidate only if it is not one of the places
  // that lists every token on the chain. Those are about the token, but they
  // are not the project — and a card that showed basescan as "possible website"
  // would be wrong about every launch at once.
  if (EXCLUDED_HOSTS_V1.some((excluded) => host === excluded || host.endsWith(`.${excluded}`))) return null;
  return 'website';
}

/**
 * Hosts that are about tokens in general rather than about one project.
 *
 * Deliberately explicit and short. An allowlist would be the wrong shape — the
 * whole point is to find a domain nobody told Miorail about — so this removes
 * only the places that would match every token equally.
 */
export const EXCLUDED_HOSTS_V1: readonly string[] = [
  'basescan.org',
  'etherscan.io',
  'blockscout.com',
  'dexscreener.com',
  'dextools.io',
  'coingecko.com',
  'coinmarketcap.com',
  'geckoterminal.com',
  'defillama.com',
  'birdeye.so',
  'poocoin.app',
  'base.org',
  'medium.com',
  'reddit.com',
  'youtube.com',
  'facebook.com',
  'linkedin.com',
  't.me',
  'telegram.org',
];

/**
 * Structured results out of one Mistral conversation response.
 *
 * Reads ONLY the `tool.execution` entry the connector wrote. The assistant's
 * message in the same response is ignored on purpose: it is the model's
 * rephrasing, and this layer takes no URL from a model.
 */
export function mistralSearchResultsV1(body: unknown): B20PublicSearchResultV1[] {
  if (typeof body !== 'object' || body === null) return [];
  const outputs = (body as { outputs?: unknown }).outputs;
  if (!Array.isArray(outputs)) return [];
  const results: B20PublicSearchResultV1[] = [];

  for (const entry of outputs) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as { type?: unknown; name?: unknown; info?: unknown };
    if (record.type !== 'tool.execution' || record.name !== 'web_search') continue;
    const info = record.info;
    if (typeof info !== 'object' || info === null) continue;
    const raw = (info as { result?: unknown }).result;
    // The provider hands the connector's result back as a JSON STRING.
    let parsed: unknown;
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
    } else {
      parsed = raw;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;

    for (const value of Object.values(parsed as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const hit = value as { url?: unknown; title?: unknown; rank?: unknown; source?: unknown };
      if (typeof hit.url !== 'string' || hit.url.length === 0) continue;
      results.push({
        url: hit.url,
        title: typeof hit.title === 'string' ? hit.title.slice(0, 200) : null,
        rank: typeof hit.rank === 'number' ? hit.rank : null,
        source: typeof hit.source === 'string' ? hit.source.slice(0, 40) : null,
      });
    }
  }

  // De-duplicated on the exact URL, keeping the first (best-ranked) occurrence.
  const seen = new Set<string>();
  return results.filter((result) => {
    if (seen.has(result.url)) return false;
    seen.add(result.url);
    return true;
  });
}

export interface MistralPublicSearchConfigV1 {
  apiKey: string;
  /** Defaults to the model the router already uses. */
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * The production search.
 *
 * `store: false` on purpose: the query carries a token address and strings a
 * deployer wrote, and there is no reason for a third party to keep a
 * conversation of them.
 */
export function createMistralPublicSearchV1(config: MistralPublicSearchConfigV1): B20PublicSearchV1 {
  const base = (config.baseUrl ?? 'https://api.mistral.ai').replace(/\/+$/, '');
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 30_000;

  return async (query: string): Promise<B20PublicSearchResultV1[]> => {
    const response = await fetchImpl(`${base}/v1/conversations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model: config.model ?? 'mistral-medium-latest',
        inputs: query,
        tools: [{ type: 'web_search' }],
        store: false,
      }),
    });
    // A failed search is an absence, not an error the caller has to interpret
    // as a fact about the token. The caller renders "nothing found" and says
    // that is about the search.
    if (!response.ok) return [];
    return mistralSearchResultsV1(await response.json());
  };
}
