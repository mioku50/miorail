// Central host allowlist for outbound partner HTTP calls (Moonwell HTTP API,
// Uniswap trade/liquidity APIs, Morpho MCP). Before this module there was no
// single place enforcing which external hosts a provider is allowed to call —
// each provider hardcoded its own endpoint. `partnerFetch` is the one function
// that should issue those requests: it fails closed on any host that is not
// explicitly allowlisted and always applies a bounded timeout.

export const ALLOWED_PARTNER_HOSTS = [
  'api.moonwell.fi',
  'trade-api.gateway.uniswap.org',
  'liquidity.api.uniswap.org',
  'mcp.morpho.org',
] as const;

export class PartnerHostNotAllowlistedError extends Error {
  readonly host: string;

  constructor(host: string) {
    super(`Partner host not allowlisted: ${host}`);
    this.name = 'PartnerHostNotAllowlistedError';
    this.host = host;
  }
}

export interface PartnerFetchOptions {
  /** Bounded request timeout. Defaults to 10s; always applied via AbortSignal.timeout. */
  timeoutMs?: number;
  /** Injectable fetch implementation for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

function isAllowlistedHost(host: string): boolean {
  return (ALLOWED_PARTNER_HOSTS as readonly string[]).includes(host);
}

/**
 * The only sanctioned way for a partner tool provider to reach an external
 * host. Throws `PartnerHostNotAllowlistedError` before any network call is
 * made if the URL's host is not in `ALLOWED_PARTNER_HOSTS`, and always attaches
 * an `AbortSignal.timeout` so a slow partner endpoint can never hang a request.
 */
export async function partnerFetch(
  url: string,
  init: RequestInit = {},
  options: PartnerFetchOptions = {},
): Promise<Response> {
  const host = new URL(url).host;
  if (!isAllowlistedHost(host)) {
    throw new PartnerHostNotAllowlistedError(host);
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  return fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
