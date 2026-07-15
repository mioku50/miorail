import {
  baseMcpPluginModeFromEnv,
  pluginScopedFetch,
  resolvePluginCredential,
  type BaseMcpPluginMode,
  type PluginHttpScope,
} from '@mioagent/security/httpAllowlist';
import {
  detectRuntimeSkill,
  getRuntimeSkill,
  type RuntimeSkillDefinition,
  type RuntimeSkillManifest,
} from './index.js';

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

export class SkillPathNotAllowedError extends Error {
  readonly plugin: string;
  readonly path: string;

  constructor(plugin: string, path: string) {
    super(`Skill executor: path is not in the ${plugin} manifest allowlist: ${path}`);
    this.name = 'SkillPathNotAllowedError';
    this.plugin = plugin;
    this.path = path;
  }
}

export interface PluginHttpRequestInput {
  plugin: string;
  url: string;
  method: 'GET' | 'POST';
  body?: unknown;
  chainId?: number;
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  mode?: BaseMcpPluginMode;
}

export interface PluginHttpResponse {
  status: number;
  data: unknown;
}

export interface BaseMcpSkillExecutor {
  namespace: string;
  manifest: RuntimeSkillManifest;
  allowedPaths: string[];
  request(input: {
    path: string;
    method: 'GET' | 'POST';
    body?: unknown;
    chainId?: number;
  }): Promise<PluginHttpResponse>;
}

const MAX_RESPONSE_TEXT_LENGTH = 200_000;
const SECRET_KEY_PATTERN =
  /^(access_?token|refresh_?token|id_?token|api_?token|secret|authorization|x-api-key|cookie|password|private_?key|credential|signature)$/i;

// T53-only explicit adapter manifest. It is deliberately absent from the
// production message-detection/list registry until the later route cutover.
const ISOLATED_HTTP_SKILLS: readonly RuntimeSkillDefinition[] = [
  {
    namespace: 'kyberswap',
    displayName: 'KyberSwap',
    allowedIntents: ['quote', 'read'],
    requiredTools: [
      { intent: 'quote', anyOf: ['kyberswap_get_routes'] },
      { intent: 'read', anyOf: ['kyberswap_get_routes'] },
    ],
    argumentMapper: (intent, input) =>
      intent === 'quote'
        ? { chain: 'base', ...input, quoteOnly: true }
        : { chain: 'base', ...input },
    resultScreener: 'kyberswap_quote',
    manifest: {
      integration: 'http-api',
      chains: [8453],
      allowlist: {
        hosts: ['aggregator-api.kyberswap.com'],
        methods: ['GET'],
        pathPrefixes: ['/base/api/v1/routes'],
      },
      auth: 'none',
      risk: ['slippage', 'aggregated-route'],
    },
    instructions: [
      'Use only the read-only KyberSwap Base route endpoint in T53.',
      'Never call token search, route build, calldata preparation, or send_calls from route adapters.',
    ],
  },
];

function getExecutorSkill(namespace: string): RuntimeSkillDefinition | undefined {
  return (
    getRuntimeSkill(namespace) ??
    ISOLATED_HTTP_SKILLS.find((skill) => skill.namespace === namespace.toLowerCase())
  );
}

function credentialHeaderName(manifest: RuntimeSkillManifest): string | null {
  return manifest.auth === 'api-key' ? 'x-api-key' : null;
}

function scrubCredential(text: string, credential: string | undefined): string {
  return credential ? text.split(credential).join('[redacted]') : text;
}

function redactSecretFields(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => redactSecretFields(item, depth + 1));
  }
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SECRET_KEY_PATTERN.test(key)
      ? '[redacted]'
      : redactSecretFields(inner, depth + 1);
  }
  return output;
}

export async function pluginHttpRequest(
  input: PluginHttpRequestInput,
): Promise<PluginHttpResponse> {
  const skill = getExecutorSkill(input.plugin);
  if (!skill?.manifest) throw new PluginNotAvailableError(input.plugin);
  const manifest = skill.manifest;

  const chainId = input.chainId ?? manifest.chains[0];
  if (!manifest.chains.includes(chainId)) {
    throw new PluginChainNotAllowedError(input.plugin, chainId);
  }

  const mode = input.mode ?? baseMcpPluginModeFromEnv();
  let credential: string | undefined;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
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
  const response = await pluginScopedFetch(
    scope,
    input.url,
    {
      method: input.method,
      headers,
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    },
    { timeoutMs: input.timeoutMs ?? 10_000, fetchImpl: input.fetchImpl },
  );

  const rawText = await response.text();
  const boundedText = rawText.slice(0, MAX_RESPONSE_TEXT_LENGTH);
  const scrubbedText = scrubCredential(boundedText, credential);
  let data: unknown;
  try {
    data = JSON.parse(scrubbedText);
  } catch {
    data = scrubbedText;
  }
  return { status: response.status, data: redactSecretFields(data) };
}

function buildExecutor(skill: RuntimeSkillDefinition): BaseMcpSkillExecutor | null {
  const manifest = skill.manifest;
  if (!manifest || manifest.integration !== 'http-api') return null;
  const host = manifest.allowlist.hosts[0];
  if (!host) return null;

  return {
    namespace: skill.namespace,
    manifest,
    allowedPaths: [...manifest.allowlist.pathPrefixes],
    async request({ path, method, body, chainId }) {
      if (!manifest.allowlist.pathPrefixes.some((prefix) => path.startsWith(prefix))) {
        throw new SkillPathNotAllowedError(skill.namespace, path);
      }
      return pluginHttpRequest({
        plugin: skill.namespace,
        url: `https://${host}${path}`,
        method,
        body,
        chainId,
      });
    },
  };
}

/** Legacy message-based selection. New route code must use loadSkillExecutor(namespace). */
export function loadSkillExecutorForMessage(message: string): BaseMcpSkillExecutor | null {
  const skill = detectRuntimeSkill(message);
  return skill ? buildExecutor(skill) : null;
}

/** Loads only an explicitly selected, manifest-constrained provider namespace. */
export function loadSkillExecutor(namespace: string): BaseMcpSkillExecutor | null {
  const skill = getExecutorSkill(namespace);
  return skill ? buildExecutor(skill) : null;
}
