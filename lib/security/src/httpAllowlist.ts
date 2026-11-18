import { BASE_MCP_PLUGIN_HOSTS_V1 } from './baseMcpPluginCatalogue.generated.js';

// Central host allowlist for outbound partner HTTP calls (Moonwell HTTP API,
// Uniswap trade/liquidity APIs, Morpho MCP + Morpho API). Before this module
// there was no single place enforcing which external hosts a provider is
// allowed to call — each provider hardcoded its own endpoint. `partnerFetch` is
// the one function that should issue those requests: it fails closed on any
// host that is not explicitly allowlisted and always applies a bounded timeout.

export const ALLOWED_PARTNER_HOSTS = [
  'api.moonwell.fi',
  'trade-api.gateway.uniswap.org',
  'liquidity.api.uniswap.org',
  'mcp.morpho.org',
  // T63A: the official Morpho GraphQL API, read-only earn vault data.
  'api.morpho.org',
  // Aave's official V4 GraphQL API: pinned read queries for Base Equities.
  'api.v4.aave.com',
  // T64: the official Bitrefill commerce API (catalogue reads and checkout).
  // Only the pinned /x402/* paths in lib/commerce-engine are ever requested.
  'api.bitrefill.com',
  // T65: the official OpenSea API v2. Read-only NFT/listing lookups plus the
  // fulfillment_data call, all under the pinned /api/v2/* paths in
  // lib/nft-engine. Every request carries a server-side x-api-key.
  'api.opensea.io',
  // T66: the official Venice API. Read-only model catalogue plus the one
  // chat/completions call, both under the pinned /api/v1/* paths in
  // lib/ai-engine. There is deliberately no configurable Venice base URL:
  // a settable provider host is how a private prompt ends up somewhere else.
  'api.venice.ai',
  // Phase 13.8: Euler's public v3 read API, for the one question the chain
  // answers only by walking 415 vault proxies — "is there a vault for this
  // exact asset". Read-only, no key, and the only path requested is
  // /v3/evk/vaults. It is a SECOND opinion on an onchain fact, never the only
  // one: the same reading was taken from the factory before this host was
  // trusted with it.
  'v3.euler.finance',
  // Coinbase's public Tokenized Stocks API, which Base's docs point integrators
  // to: no key, read-only, and the only path requested is /v1/tokenized-stocks.
  // The Stocks list reads each token's name and icon address from it.
  'api.coinbase.com',
  // Where that API's `icon_url` points. Only /equity_icons/<sha256>.png is ever
  // requested, and the bytes are served to readers from our own origin.
  'metadata.coinbase.com',
] as const;

export class PartnerHostNotAllowlistedError extends Error {
  readonly host: string;

  constructor(host: string) {
    super(`Partner host not allowlisted: ${host}`);
    this.name = 'PartnerHostNotAllowlistedError';
    this.host = host;
  }
}

/** A request to an allowlisted host that is refused all the same: it is not
 * HTTPS, or it is a redirect this transport does not follow. */
export class PartnerRequestRefusedError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`Partner request refused: ${detail}`);
    this.name = 'PartnerRequestRefusedError';
    this.detail = detail;
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

// ---------------------------------------------------------------------------
// One transport policy for both clients in this file (audit P2-6, 2026-11-18).
//
// Each checked the URL its caller passed and then let fetch follow redirects by
// itself, so a redirect from an allowlisted host went wherever it pointed with
// no check at all. Fetch removes only `Authorization` when a redirect changes
// origin: OpenSea's `x-api-key` and a plugin's credential header would have
// travelled on to the new host. So, for both:
//
//   * HTTPS only, for the URL a caller passes and for every hop after it;
//   * redirects are followed here, never by the platform: at most
//     ALLOWLISTED_MAX_REDIRECTS_V1 of them, each hop checked exactly like the
//     first URL (its host, and for a plugin its method and path as well);
//   * a redirect to another origin is refused, so a credential header only ever
//     reaches the origin it was issued for;
//   * a caller's own `redirect: 'error'` (or 'manual') is kept as it is.
//
// One clock covers the request and every hop it takes.
// ---------------------------------------------------------------------------

export const ALLOWLISTED_MAX_REDIRECTS_V1 = 3;
const REDIRECT_STATUSES_V1 = new Set([301, 302, 303, 307, 308]);
/** What fetch drops with the body when a redirect turns a request into a GET. */
const REQUEST_BODY_HEADERS_V1 = ['content-encoding', 'content-language', 'content-location', 'content-type'];

interface AllowlistedHopPolicyV1 {
  /** Throws unless this URL may be asked with this method: the first URL and every hop alike. */
  check(target: URL, method: string): void;
  /** The error for a redirect that is not followed. */
  refuse(detail: string): Error;
}

async function fetchAllowlistedV1(
  url: string,
  init: RequestInit,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch },
  policy: AllowlistedHopPolicyV1,
): Promise<Response> {
  let target = new URL(url);
  let method = String(init.method || 'GET').toUpperCase();
  policy.check(target, method);
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  if (init.redirect === 'error' || init.redirect === 'manual') return fetchImpl(url, { ...init, signal });

  let hop: RequestInit = { ...init, redirect: 'manual', signal };
  let response = await fetchImpl(url, hop);
  for (let followed = 0; REDIRECT_STATUSES_V1.has(response.status); followed += 1) {
    const location = response.headers.get('location');
    // A redirect that names no destination is an answer, as fetch itself treats it.
    if (location === null) return response;
    await response.body?.cancel().catch(() => undefined);
    if (followed === ALLOWLISTED_MAX_REDIRECTS_V1) throw policy.refuse(`more than ${ALLOWLISTED_MAX_REDIRECTS_V1} redirects`);
    let next: URL;
    try {
      next = new URL(location, target);
    } catch {
      throw policy.refuse('a redirect to an unreadable location');
    }
    if (next.origin !== target.origin) throw policy.refuse(`a redirect to another origin (${next.origin})`);
    // As fetch does it: a 303, or a 301 or 302 answering a POST, is asked again as a GET with no body.
    const asGet = response.status === 303
      ? method !== 'GET' && method !== 'HEAD'
      : (response.status === 301 || response.status === 302) && method === 'POST';
    if (asGet) {
      method = 'GET';
      const headers = new Headers(hop.headers);
      for (const name of REQUEST_BODY_HEADERS_V1) headers.delete(name);
      hop = { ...hop, method, headers, body: null };
    }
    policy.check(next, method);
    target = next;
    response = await fetchImpl(target.toString(), hop);
  }
  return response;
}

const partnerHopPolicyV1: AllowlistedHopPolicyV1 = {
  check(target) {
    if (!isAllowlistedHost(target.host)) throw new PartnerHostNotAllowlistedError(target.host);
    if (target.protocol !== 'https:') throw new PartnerRequestRefusedError(`${target.protocol} is not https:`);
  },
  refuse: (detail) => new PartnerRequestRefusedError(detail),
};

/**
 * The only sanctioned way for a partner tool provider to reach an external
 * host. Throws `PartnerHostNotAllowlistedError` before any network call is
 * made if the URL's host is not in `ALLOWED_PARTNER_HOSTS`, and
 * `PartnerRequestRefusedError` for a URL that is not HTTPS or a redirect it
 * does not follow (see above). Always attaches an `AbortSignal.timeout` so a
 * slow partner endpoint can never hang a request.
 */
export async function partnerFetch(
  url: string,
  init: RequestInit = {},
  options: PartnerFetchOptions = {},
): Promise<Response> {
  return fetchAllowlistedV1(url, init, options, partnerHopPolicyV1);
}

// ---------------------------------------------------------------------------
// T48b: plugin-scoped allowlist for the server-side `plugin_http_request`
// gateway (artifacts/api-server/lib/pluginHttpGateway.ts). Unlike
// `partnerFetch` (host-only, shared across all partner providers),
// `pluginScopedFetch` enforces a per-plugin scope taken from the plugin's
// structured manifest (lib/runtime-skills): host, HTTP method, AND path
// prefix must all match before any network call is made. This is what makes
// prompt injection unable to redirect a plugin call to another host or path
// — the scope comes from the manifest, never from LLM output.
// ---------------------------------------------------------------------------

export interface PluginHttpScope {
  pluginId: string;
  hosts: string[];
  /** Omit to allow any method this gateway supports. A plugin with a
   * hand-written manifest still names its methods and keeps them enforced. */
  methods?: ('GET' | 'POST')[];
  /** Omit to allow any path on an allowlisted host. See the note below on why
   * that is the right default for specs Miorail did not author. */
  pathPrefixes?: string[];
}

// ---------------------------------------------------------------------------
// Why the path and method checks became optional.
//
// The scope started as host + method + path prefix, all mandatory, derived
// from a manifest Miorail wrote per plugin. That is the tightest boundary
// available and it is worth keeping — for the four plugins that have such a
// manifest.
//
// It also meant the other seventeen native Base plugins could not be reached
// at all, because nobody had written their manifest yet. The boundary was not
// protecting anything there; it was just absent capability wearing a security
// justification.
//
// So the rule is now: enforce whatever the scope DECLARES. A manifest that
// names methods and paths keeps every check it had. A plugin known only from
// Base's published spec is pinned to its hosts and left free within them.
//
// Host pinning is the part that actually stops the attack this exists for. The
// threat is prompt injection — untrusted text reaching the model through token
// names, NFT metadata or a provider response — steering a call at an attacker's
// server. That is defeated by the host list, which comes from a generated file
// and never from model output. A wrong path on the RIGHT host is a bad request
// to a protocol the user chose; a right path on the WRONG host is exfiltration.
//
// What has not moved: nothing here signs, and every transaction still lands in
// front of the user in Base Account.
// ---------------------------------------------------------------------------

export type PluginHttpScopeViolationCode = 'host' | 'method' | 'path' | 'scheme' | 'redirect';

export class PluginHttpScopeError extends Error {
  readonly pluginId: string;
  readonly code: PluginHttpScopeViolationCode;
  readonly detail: string;

  constructor(pluginId: string, code: PluginHttpScopeViolationCode, detail: string) {
    super(`Plugin HTTP scope violation (${pluginId}): ${code} not allowed — ${detail}`);
    this.name = 'PluginHttpScopeError';
    this.pluginId = pluginId;
    this.code = code;
    this.detail = detail;
  }
}

/**
 * The scope for a native Base plugin Miorail has no manifest for.
 *
 * Hosts come from `baseMcpPluginCatalogue.generated.ts`, produced by
 * `scripts/refreshBaseMcpPluginCatalogue.mts` from the same specs Claude and
 * ChatGPT load — specifically from each spec's own `requires.allowlist`. Null
 * for a plugin Base does not publish, or one that declares no API host at all
 * (aerodrome and balancer run through a shell; `yo` goes straight to chain).
 * A null scope means no request, because an unknown plugin is not a plugin
 * with an empty allowlist, it is one nobody checked.
 */
export function baseMcpPluginScopeV1(pluginId: string): PluginHttpScope | null {
  const hosts = BASE_MCP_PLUGIN_HOSTS_V1[pluginId];
  if (!hosts || hosts.length === 0) return null;
  return { pluginId, hosts: [...hosts] };
}

export interface PluginScopedFetchOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * The only sanctioned way for `plugin_http_request` to reach an external
 * host. Validates host, scheme, method, and path prefix against the plugin's
 * own scope (derived from its manifest) before any network call is made, and
 * again for every redirect it follows (see `fetchAllowlistedV1`); always
 * attaches an `AbortSignal.timeout`.
 */
export async function pluginScopedFetch(
  scope: PluginHttpScope,
  url: string,
  init: RequestInit = {},
  options: PluginScopedFetchOptions = {},
): Promise<Response> {
  return fetchAllowlistedV1(url, init, options, {
    check(target, method) {
      if (!scope.hosts.includes(target.host)) {
        throw new PluginHttpScopeError(scope.pluginId, 'host', target.host);
      }
      if (target.protocol !== 'https:') {
        throw new PluginHttpScopeError(scope.pluginId, 'scheme', target.protocol);
      }
      // Declared, therefore enforced. An undeclared list is not an empty one: a
      // scope built from Base's published spec knows the hosts and nothing more,
      // and refusing every method because none was named would block the plugin
      // it was written to enable.
      if (scope.methods && !scope.methods.includes(method as 'GET' | 'POST')) {
        throw new PluginHttpScopeError(scope.pluginId, 'method', method);
      }
      if (scope.pathPrefixes && !scope.pathPrefixes.some((prefix) => target.pathname.startsWith(prefix))) {
        throw new PluginHttpScopeError(scope.pluginId, 'path', target.pathname);
      }
    },
    refuse: (detail) => new PluginHttpScopeError(scope.pluginId, 'redirect', detail),
  });
}

// ---------------------------------------------------------------------------
// T48b: BASE_MCP_PLUGIN_MODE + server-side credential resolution.
// mcp mode (default) reads UNISWAP_MCP_GATEWAY_KEY — a server-only secret
// used when the plugin is reached through the constrained gateway rather
// than a live Base MCP tool. direct mode keeps the legacy UNISWAP_API_KEY
// fallback. UNISWAP_API_KEY is intentionally NOT a release-gate in mcp mode:
// read-only Uniswap quotes must work in mcp mode with only
// UNISWAP_MCP_GATEWAY_KEY configured. The resolved credential is never
// logged, echoed in a tool trace, or returned to the LLM/caller.
// ---------------------------------------------------------------------------

export type BaseMcpPluginMode = 'mcp' | 'direct';

export function baseMcpPluginModeFromEnv(): BaseMcpPluginMode {
  return String(process.env.BASE_MCP_PLUGIN_MODE || 'mcp').trim().toLowerCase() === 'direct' ? 'direct' : 'mcp';
}

export function resolvePluginCredential(plugin: string, mode: BaseMcpPluginMode = baseMcpPluginModeFromEnv()): string | undefined {
  if (plugin === 'uniswap') {
    // The gateway key wins wherever it is configured — that part is unchanged.
    //
    // What changed is the else. In mcp mode with no gateway key, this returned
    // undefined and the request failed with PluginCredentialMissingError, even
    // though UNISWAP_API_KEY was set and valid. That looked like a config
    // mistake and was not one: the executor builds a plain HTTPS request to
    // `trade-api.gateway.uniswap.org`, Uniswap's own API, whose credential IS
    // UNISWAP_API_KEY. The mode names a routing arrangement this call does not
    // use, so it was gating a key against the wrong question.
    //
    // In production that silently removed Uniswap from every comparison. With
    // KyberSwap also refusing, one provider was left, which the engine reports
    // as `single_provider_available` — no recommendation, no Route Card,
    // nothing to review.
    //
    // Falling back is safe because the host is pinned by the plugin allowlist
    // above: this key can only ever be sent to the API that issued it. It is
    // never logged, echoed in a tool trace, or returned to a caller.
    const raw =
      mode === 'direct'
        ? process.env.UNISWAP_API_KEY
        : (process.env.UNISWAP_MCP_GATEWAY_KEY?.trim() || process.env.UNISWAP_API_KEY);
    return raw?.trim() || undefined;
  }
  // OpenSea's public API authenticates with a server-side key only. T65 forbids
  // creating one automatically and forbids running the OpenSea CLI in
  // production, so there is one source and no fallback: an absent key is an
  // unavailable read, never a key this process invents.
  if (plugin === 'opensea') return process.env.OPENSEA_API_KEY?.trim() || undefined;
  if (plugin === 'gmgn') return process.env.GMGN_API_KEY?.trim() || undefined;
  return undefined;
}
