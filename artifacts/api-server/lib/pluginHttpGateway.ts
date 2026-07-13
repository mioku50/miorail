// T48b: constrained, server-side typed gateway for official Base MCP HTTP
// plugins (Uniswap, Moonwell). This is NOT an LLM tool and NOT a proxy for an
// MCP `web_request` tool — Miorail's own backend is the HTTP-capable harness
// the base/skills custom-plugins doc calls the preferred path over
// `web_request`. `pluginHttpRequest` is called only by deterministic
// server-side routing (streamBaseAppNativeRouting.ts, baseMcpSkillExecutor.ts)
// and is never registered on the ToolAggregator, so the generic LLM loop in
// lib/agent never sees it, exactly like it never sees `send_calls` or
// `web_request` (lib/agent/src/index.ts isWriteTool/isGenericHttpTool).
//
// Every call is checked, in order, before any network request is issued:
//   1. the plugin is a known runtime skill with a manifest (else reject);
//   2. the requested chain is in the plugin's manifest.chains (else reject);
//   3. host/method/path go through `pluginScopedFetch` against
//      manifest.allowlist (else reject) — the scope comes from the manifest,
//      never from caller input, so prompt injection cannot redirect a call.
// Outgoing headers are whitelist-only: `content-type` plus, for auth:
// 'api-key' plugins, an `x-api-key` resolved server-side via
// `resolvePluginCredential` (env-only, mode-aware). Any headers the caller
// passes are ignored — nothing from the LLM/model reaches the wire here.
// The response is size-bounded and the resolved credential is stripped from
// the body text before it is parsed or returned, so it can never leak into a
// tool trace, the chat response, or a log line.

import {
  pluginScopedFetch,
  resolvePluginCredential,
  baseMcpPluginModeFromEnv,
  type PluginHttpScope,
  type BaseMcpPluginMode,
} from '@mioagent/security/httpAllowlist';
import { getRuntimeSkill, type RuntimeSkillManifest } from '@mioagent/runtime-skills';

export class PluginNotAvailableError extends Error {
  readonly plugin: string;
  constructor(plugin: string) {
    super(`Plugin is not a known runtime skill with an HTTP manifest: ${plugin}`);
    this.name = 'PluginNotAvailableError';
    this.plugin = plugin;
  }
}

export class PluginChainNotAllowedError extends Error {
  readonly plugin: string;
  readonly chainId: number;
  constructor(plugin: string, chainId: number) {
    super(`Plugin ${plugin} does not allow chain ${chainId}`);
    this.name = 'PluginChainNotAllowedError';
    this.plugin = plugin;
    this.chainId = chainId;
  }
}

export class PluginCredentialMissingError extends Error {
  readonly plugin: string;
  constructor(plugin: string) {
    super(`No server-side credential is configured for plugin: ${plugin}`);
    this.name = 'PluginCredentialMissingError';
    this.plugin = plugin;
  }
}

export interface PluginHttpRequestInput {
  /** Runtime skill namespace, e.g. 'uniswap' | 'moonwell'. */
  plugin: string;
  url: string;
  method: 'GET' | 'POST';
  body?: unknown;
  /** Defaults to the plugin manifest's first chain (8453 for every current plugin). */
  chainId?: number;
  /**
   * Additional headers set by TRUSTED SERVER ROUTING CODE ONLY (never by the
   * LLM or user input — this function is not an LLM tool). Cannot override
   * content-type or the resolved credential header.
   */
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  mode?: BaseMcpPluginMode;
}

export interface PluginHttpResponse {
  status: number;
  data: unknown;
}

const MAX_RESPONSE_TEXT_LENGTH = 200_000;

function credentialHeaderName(manifest: RuntimeSkillManifest): string | null {
  return manifest.auth === 'api-key' ? 'x-api-key' : null;
}

function scrubCredential(text: string, credential: string | undefined): string {
  if (!credential) return text;
  return text.split(credential).join('[redacted]');
}

const SECRET_KEY_PATTERN = /^(access_?token|refresh_?token|id_?token|api_?token|secret|authorization|x-api-key|cookie|password|private_?key|credential|signature)$/i;

function redactSecretFields(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redactSecretFields(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? '[redacted]' : redactSecretFields(inner, depth + 1);
  }
  return out;
}

/**
 * The single server-side entry point for HTTP calls into an official Base
 * MCP HTTP plugin (Uniswap, Moonwell). See module header for the full
 * ordered check list and the credential/redaction guarantees.
 */
export async function pluginHttpRequest(input: PluginHttpRequestInput): Promise<PluginHttpResponse> {
  const skill = getRuntimeSkill(input.plugin);
  if (!skill?.manifest) throw new PluginNotAvailableError(input.plugin);
  const manifest = skill.manifest;

  const chainId = input.chainId ?? manifest.chains[0];
  if (!manifest.chains.includes(chainId)) throw new PluginChainNotAllowedError(input.plugin, chainId);

  const mode = input.mode ?? baseMcpPluginModeFromEnv();
  let credential: string | undefined;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  // Trusted, server-set extra headers (routing code only — never LLM/user
  // input) are merged first so they can never shadow the credential header
  // or content-type set below.
  if (input.extraHeaders) Object.assign(headers, input.extraHeaders);
  headers['content-type'] = 'application/json';

  const credentialHeader = credentialHeaderName(manifest);
  if (credentialHeader) {
    credential = resolvePluginCredential(input.plugin, mode);
    if (!credential) throw new PluginCredentialMissingError(input.plugin);
    headers[credentialHeader] = credential;
  }

  const scope: PluginHttpScope = {
    pluginId: input.plugin,
    hosts: manifest.allowlist.hosts,
    methods: manifest.allowlist.methods,
    pathPrefixes: manifest.allowlist.pathPrefixes,
  };

  const response = await pluginScopedFetch(scope, input.url, {
    method: input.method,
    headers,
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
  }, { timeoutMs: input.timeoutMs ?? 10_000, fetchImpl: input.fetchImpl });

  const rawText = await response.text();
  const boundedText = rawText.length > MAX_RESPONSE_TEXT_LENGTH ? rawText.slice(0, MAX_RESPONSE_TEXT_LENGTH) : rawText;
  const scrubbedText = scrubCredential(boundedText, credential);

  let data: unknown;
  try {
    data = JSON.parse(scrubbedText);
  } catch {
    data = scrubbedText;
  }

  return { status: response.status, data: redactSecretFields(data) };
}
