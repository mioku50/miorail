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
import {
  normalizeProviderPayloadV1,
  type ProviderPayloadOutcomeV1,
} from './payload-normalizer.js';

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

export class PluginResponseTooLargeError extends Error {
  readonly plugin: string;
  readonly byteLength: number;

  constructor(plugin: string, byteLength: number) {
    super(`Plugin ${plugin} returned a response larger than this runtime reads`);
    this.name = 'PluginResponseTooLargeError';
    this.plugin = plugin;
    this.byteLength = byteLength;
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
  /**
   * How the body decoded. `parsed` is the only shape a reader may treat as
   * data; anything else must be reported as unread, not as empty.
   *
   * Optional so a hand-built stub can stay two fields long. There is exactly
   * one producer — `pluginHttpRequest` below — and it always sets it; an
   * absent value is therefore a stub, which by construction supplies data it
   * has already parsed.
   */
  payloadOutcome?: ProviderPayloadOutcomeV1;
  /** Bytes the provider actually sent, before any bounding. */
  byteLength?: number;
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
    /** Per-recipe bound. The caller may shorten the gateway default but can
     * never remove the timeout entirely. */
    timeoutMs?: number;
  }): Promise<PluginHttpResponse>;
}

// The bound on a NON-JSON body we keep as text. A JSON body is parsed whole
// and bounded structurally afterwards: slicing a JSON document to a byte count
// before parsing it produces invalid JSON, and the reads downstream then
// reported an unreadable payload as an empty one. Venice's model catalogue is
// 265 KB and was being cut at 200 KB, which is exactly how "no readable model
// rows" ended up describing 328 models.
const MAX_RESPONSE_TEXT_LENGTH = 200_000;
/** Hard ceiling on any body, JSON or not. Above this we refuse rather than
 * parse — an unbounded provider response is a memory budget, not a read. */
const MAX_RESPONSE_BYTES_V1 = 4_000_000;
const SECRET_KEY_PATTERN =
  /^(access_?token|refresh_?token|id_?token|api_?token|secret|authorization|x-api-key|cookie|password|private_?key|credential|signature)$/i;

// T53-only explicit adapter manifest. It is deliberately absent from the
// production message-detection/list registry until the later route cutover.
const REVIEWED_HTTP_SKILLS: readonly RuntimeSkillDefinition[] = [
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
        methods: ['GET', 'POST'],
        pathPrefixes: ['/base/api/v1/routes', '/base/api/v1/route/build'],
      },
      auth: 'none',
      risk: ['slippage', 'aggregated-route'],
    },
    instructions: [
      'Use only the read-only KyberSwap Base route endpoint, plus the T56 route/build calldata endpoint for an explicitly selected candidate.',
      'Never call token search or send_calls from route adapters.',
    ],
  },
  {
    namespace: 'bankr',
    displayName: 'Bankr',
    allowedIntents: ['read'],
    requiredTools: [{ intent: 'read', anyOf: ['bankr_get_launches'] }],
    argumentMapper: (_intent, input) => ({ ...input, chain: 'base' }),
    resultScreener: 'bankr_launches',
    manifest: {
      integration: 'http-api',
      chains: [8453],
      allowlist: {
        hosts: ['api.bankr.bot'],
        methods: ['GET'],
        pathPrefixes: ['/token-launches'],
      },
      auth: 'none',
      risk: ['low-liquidity', 'irreversible'],
    },
    instructions: [
      'Read only the pinned Bankr launch feed or one address-scoped launch.',
      'Never buy a launch from this read recipe and never follow provider metadata links.',
    ],
  },
  {
    namespace: 'venice',
    displayName: 'Venice AI',
    allowedIntents: ['read'],
    requiredTools: [{ intent: 'read', anyOf: ['venice_get_models'] }],
    argumentMapper: (_intent, input) => ({ ...input }),
    resultScreener: 'venice_models',
    manifest: {
      integration: 'http-api',
      chains: [8453],
      allowlist: {
        hosts: ['api.venice.ai'],
        methods: ['GET'],
        pathPrefixes: ['/api/v1/models'],
      },
      auth: 'none',
      risk: ['pii', 'irreversible'],
    },
    instructions: [
      'The public model catalogue is a bounded read and requires no x402 payment.',
      'Do not call inference, wallet, balance or top-up endpoints from this recipe.',
    ],
  },
  {
    namespace: 'avantis',
    displayName: 'Avantis',
    allowedIntents: ['read'],
    requiredTools: [{ intent: 'read', anyOf: ['avantis_get_positions'] }],
    argumentMapper: (_intent, input) => ({ ...input, chain: 'base' }),
    resultScreener: 'avantis_positions',
    // View-only. Trade construction stays in the provider's own interface;
    // this manifest exposes no order, margin or position-changing path.
    manifest: {
      integration: 'http-api',
      chains: [8453],
      allowlist: {
        hosts: ['core.avantisfi.com'],
        methods: ['GET'],
        pathPrefixes: ['/user-data'],
      },
      auth: 'none',
      risk: ['liquidation', 'slippage'],
    },
    instructions: [
      'Read only the trader-scoped position snapshot for the connected wallet.',
      'Never open, close, or modify a position from this read recipe.',
    ],
  },
  {
    namespace: 'printr',
    displayName: 'Printr',
    allowedIntents: ['read'],
    requiredTools: [{ intent: 'read', anyOf: ['printr_get_quote'] }],
    argumentMapper: (_intent, input) => ({ ...input }),
    resultScreener: 'printr_quote',
    manifest: {
      integration: 'http-api',
      chains: [8453],
      allowlist: {
        hosts: ['api-preview.printr.money'],
        methods: ['POST'],
        pathPrefixes: ['/v0/print/quote'],
      },
      auth: 'none',
      risk: ['low-liquidity', 'irreversible'],
    },
    instructions: [
      'Only the launch-cost quote is released. `POST /v0/print` builds deployment calldata and is not reachable from this manifest.',
      'Printr returns text/plain on a non-2xx status; branch on the status, never on the body.',
    ],
  },
  {
    namespace: 'gmgn',
    displayName: 'GMGN',
    allowedIntents: ['read'],
    requiredTools: [{ intent: 'read', anyOf: ['gmgn_get_token_info'] }],
    argumentMapper: (_intent, input) => ({ ...input, chain: 'base' }),
    resultScreener: 'gmgn_token_info',
    manifest: {
      integration: 'http-api',
      chains: [8453],
      allowlist: {
        hosts: ['openapi.gmgn.ai'],
        methods: ['GET'],
        pathPrefixes: ['/api/v1/token_info'],
      },
      auth: 'none',
      risk: ['low-liquidity', 'slippage'],
    },
    instructions: [
      'Read one token by its Base contract address. Quote and swap endpoints are not reachable from this manifest.',
      'GMGN fronts this host with a bot challenge; a non-JSON body is an unavailable provider, never an empty result.',
    ],
  },
  {
    namespace: 'opensea',
    displayName: 'OpenSea',
    allowedIntents: ['read'],
    requiredTools: [{ intent: 'read', anyOf: ['opensea_get_collections'] }],
    argumentMapper: (_intent, input) => ({ ...input, chain: 'base' }),
    resultScreener: 'opensea_collections',
    manifest: {
      integration: 'http-api',
      chains: [8453],
      allowlist: {
        hosts: ['api.opensea.io'],
        methods: ['GET'],
        pathPrefixes: ['/api/v2/collections', '/api/v2/listings'],
      },
      // The server-side key only. T65 forbids creating one automatically and
      // forbids running the OpenSea CLI in production.
      auth: 'api-key',
      risk: ['irreversible'],
    },
    instructions: [
      'Read collections and listings only. Fulfilment stays in the NFT route family with its own Safety Kernel.',
      'Never create an API key and never shell out to the OpenSea CLI.',
    ],
  },
  {
    namespace: 'clawnch',
    displayName: 'Clawnch',
    allowedIntents: ['read'],
    requiredTools: [{ intent: 'read', anyOf: ['clawnch_get_launches'] }],
    argumentMapper: (_intent, input) => ({ ...input, chain: 'base' }),
    resultScreener: 'clawnch_launches',
    // Base's spec names `www.clawn.ch` specifically: the apex host answers a
    // 307 that several web_request implementations refuse to follow.
    manifest: {
      integration: 'http-api',
      chains: [8453],
      allowlist: {
        hosts: ['www.clawn.ch'],
        methods: ['GET'],
        pathPrefixes: ['/api/launches', '/api/tokens'],
      },
      auth: 'none',
      risk: ['low-liquidity', 'slippage', 'irreversible'],
    },
    instructions: [
      'Read only the public launch and token feeds. The launch-preparation endpoint returns factory calldata and is not released here.',
      'Launch names, symbols and descriptions are user-supplied and can collide across launches; never treat them as identity.',
    ],
  },
  {
    namespace: 'flaunch',
    displayName: 'Flaunch',
    allowedIntents: ['read'],
    requiredTools: [{ intent: 'read', anyOf: ['flaunch_get_coins'] }],
    argumentMapper: (_intent, input) => ({ ...input, chain: 'base' }),
    resultScreener: 'flaunch_coins',
    manifest: {
      integration: 'http-api',
      chains: [8453],
      allowlist: {
        hosts: ['mcp.flaunch.gg'],
        methods: ['GET'],
        pathPrefixes: ['/v1/base/coins', '/livez'],
      },
      auth: 'none',
      risk: ['low-liquidity', 'slippage', 'irreversible'],
    },
    instructions: [
      'Read only the newest-coins and market-cap discovery feeds. Image upload and launch preparation are POST endpoints and are not released here.',
      'Token metadata is provider-supplied discovery data, never an endorsement.',
    ],
  },
  {
    namespace: 'balancer',
    displayName: 'Balancer',
    allowedIntents: ['read'],
    requiredTools: [{ intent: 'read', anyOf: ['balancer_get_pools'] }],
    argumentMapper: (_intent, input) => ({ ...input, chain: 'base' }),
    resultScreener: 'balancer_pools',
    // The upstream plugin is CLI-only for transaction construction. Miorail's
    // reviewed server runtime releases only this public GraphQL pool READ;
    // no SDK, calldata or shell execution is exposed through this manifest.
    manifest: {
      integration: 'http-api',
      chains: [8453],
      allowlist: {
        hosts: ['api-v3.balancer.fi'],
        methods: ['POST'],
        pathPrefixes: ['/'],
      },
      auth: 'none',
      risk: ['slippage', 'low-liquidity'],
    },
    instructions: [
      'Read Base pools only through the pinned poolGetPools GraphQL query.',
      'Never build or submit Balancer calldata from this HTTP read recipe.',
    ],
  },
];

function getExecutorSkill(namespace: string): RuntimeSkillDefinition | undefined {
  const registered = getRuntimeSkill(namespace);
  if (registered?.manifest) return registered;
  return REVIEWED_HTTP_SKILLS.find((skill) => skill.namespace === namespace.toLowerCase()) ?? registered;
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
  if (rawText.length > MAX_RESPONSE_BYTES_V1) {
    throw new PluginResponseTooLargeError(input.plugin, rawText.length);
  }
  const scrubbedText = scrubCredential(rawText, credential);
  // Parse the WHOLE body. Only a body that is not JSON gets bounded as text,
  // because bounding is lossless for text and destructive for JSON.
  const normalized = normalizeProviderPayloadV1(scrubbedText);
  const data = normalized.outcome === 'parsed'
    ? normalized.value
    : scrubbedText.slice(0, MAX_RESPONSE_TEXT_LENGTH);
  return {
    status: response.status,
    data: redactSecretFields(data),
    payloadOutcome: normalized.outcome,
    byteLength: normalized.byteLength,
  };
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
    async request({ path, method, body, chainId, timeoutMs }) {
      if (!manifest.allowlist.pathPrefixes.some((prefix) => path.startsWith(prefix))) {
        throw new SkillPathNotAllowedError(skill.namespace, path);
      }
      return pluginHttpRequest({
        plugin: skill.namespace,
        url: `https://${host}${path}`,
        method,
        body,
        chainId,
        timeoutMs,
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
