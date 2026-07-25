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
  methods: ('GET' | 'POST')[];
  pathPrefixes: string[];
}

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
  if (!scope.methods.includes(method)) {
    throw new PluginHttpScopeError(scope.pluginId, 'method', method);
  }
  if (!scope.pathPrefixes.some((prefix) => parsed.pathname.startsWith(prefix))) {
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
    const raw = mode === 'direct' ? process.env.UNISWAP_API_KEY : process.env.UNISWAP_MCP_GATEWAY_KEY;
    return raw?.trim() || undefined;
  }
  return undefined;
}
