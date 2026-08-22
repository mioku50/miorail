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

export type PluginHttpScopeViolationCode = 'host' | 'method' | 'path';

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
 * host. Validates host, method, and path prefix against the plugin's own
 * scope (derived from its manifest) before any network call is made, and
 * always attaches an `AbortSignal.timeout`.
 */
export async function pluginScopedFetch(
  scope: PluginHttpScope,
  url: string,
  init: RequestInit = {},
  options: PluginScopedFetchOptions = {},
): Promise<Response> {
  const parsed = new URL(url);
  if (!scope.hosts.includes(parsed.host)) {
    throw new PluginHttpScopeError(scope.pluginId, 'host', parsed.host);
  }
  const method = String(init.method || 'GET').toUpperCase() as 'GET' | 'POST';
  // Declared, therefore enforced. An undeclared list is not an empty one: a
  // scope built from Base's published spec knows the hosts and nothing more,
  // and refusing every method because none was named would block the plugin
  // it was written to enable.
  if (scope.methods && !scope.methods.includes(method)) {
    throw new PluginHttpScopeError(scope.pluginId, 'method', method);
  }
  if (scope.pathPrefixes && !scope.pathPrefixes.some((prefix) => parsed.pathname.startsWith(prefix))) {
    throw new PluginHttpScopeError(scope.pluginId, 'path', parsed.pathname);
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  return fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
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
  return undefined;
}
