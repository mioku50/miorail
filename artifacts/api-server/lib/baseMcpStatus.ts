export type BaseMcpProviderStatus =
  | 'missing'
  | 'disabled'
  | 'connected'
  | 'needs_reauth'
  | 'unreachable'
  | 'degraded'
  | 'unsupported';

export interface BaseMcpStatus {
  status: BaseMcpProviderStatus;
  provider: 'base-mcp';
  configured: boolean;
  enabled: boolean;
  endpointHost?: string;
  lastCheckedAt?: string;
  errorCode?: string;
  readiness?: 'not_configured' | 'configured' | 'oauth_connected' | 'tools_available' | 'degraded';
  usable?: boolean;
  capabilities?: {
    toolsCount?: number;
    resourcesCount?: number;
  };
  toolsCount?: number;
  readOnlyToolsCount?: number;
  transactionToolsCount?: number;
  forbiddenToolsCount?: number;
  unknownToolsCount?: number;
  lastToolProbeAt?: string;
  auth?: {
    connected: boolean;
    needsReauth: boolean;
    userScoped: true;
    expired?: boolean;
    expiresAt?: string;
    connectedAt?: string;
  };
}

const DEFAULT_STATUS_PATH = '/health';
const DEFAULT_TIMEOUT_MS = 2500;
const SUCCESS_TTL_MS = 30_000;
const FAILURE_COOLDOWN_MS = 30_000;

let cached: { configKey: string; status: BaseMcpStatus; expiresAt: number } | null = null;
let inflight: Promise<BaseMcpStatus> | null = null;
let warnedLegacyBaseMcpUrl = false;
let toolProbe:
  | {
      configKey: string;
      endpointHost: string;
      toolsCount: number;
      readOnlyToolsCount: number;
      transactionToolsCount: number;
      forbiddenToolsCount: number;
      unknownToolsCount: number;
      checkedAt: string;
    }
  | null = null;

function parseBool(value?: string): boolean {
  return ['1', 'true', 'yes', 'y', 'on'].includes((value || '').trim().toLowerCase());
}

function statusPathFromEnv(): string {
  const raw = process.env.BASE_MCP_STATUS_PATH || DEFAULT_STATUS_PATH;
  if (!raw.trim()) return DEFAULT_STATUS_PATH;
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function timeoutFromEnv(): number {
  const parsed = Number(process.env.BASE_MCP_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(parsed, 30_000);
}

export function baseMcpEnabledFromEnv(): boolean {
  return parseBool(process.env.BASE_MCP_ENABLED);
}

export function baseMcpServerUrlFromEnv(): URL | null {
  const canonical = (process.env.BASE_MCP_SERVER_URL || '').trim();
  const legacy = (process.env.MCP_SERVER_URL || process.env.BASE_MCP_URL || '').trim();
  const raw = canonical || legacy;
  if (!canonical && legacy && !warnedLegacyBaseMcpUrl) {
    warnedLegacyBaseMcpUrl = true;
    console.warn('BASE_MCP_SERVER_URL is the canonical Base MCP env; MCP_SERVER_URL and BASE_MCP_URL are deprecated aliases.');
  }
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function endpointFromEnv(): URL | null {
  return baseMcpServerUrlFromEnv();
}

function configKey(): string {
  return [
    process.env.BASE_MCP_ENABLED || '',
    process.env.BASE_MCP_SERVER_URL || process.env.MCP_SERVER_URL || process.env.BASE_MCP_URL || '',
    process.env.BASE_MCP_STATUS_PATH || '',
    process.env.BASE_MCP_TIMEOUT_MS || '',
  ].join('|');
}

function staticStatus(): BaseMcpStatus | null {
  const enabled = baseMcpEnabledFromEnv();
  const endpoint = endpointFromEnv();
  const configured = endpoint !== null;
  const endpointHost = endpoint?.host;

  if (!configured) {
    return {
      status: 'missing',
      provider: 'base-mcp',
      configured: false,
      enabled,
    };
  }

  if (!enabled) {
    return {
      status: 'disabled',
      provider: 'base-mcp',
      configured: true,
      enabled: false,
      endpointHost,
    };
  }

  return null;
}

function baseStatus(): { endpoint: URL; status: BaseMcpStatus } | BaseMcpStatus {
  const enabled = baseMcpEnabledFromEnv();
  const endpoint = endpointFromEnv();
  const configured = endpoint !== null;
  const endpointHost = endpoint?.host;

  if (!configured) {
    return {
      status: 'missing',
      provider: 'base-mcp',
      configured: false,
      enabled,
    };
  }

  return {
    endpoint,
    status: {
      status: enabled ? 'unreachable' : 'disabled',
      provider: 'base-mcp',
      configured: true,
      enabled,
      endpointHost,
    },
  };
}

function statusUrl(endpoint: URL): string {
  const url = new URL(endpoint.toString());
  url.pathname = statusPathFromEnv();
  url.search = '';
  url.hash = '';
  return url.toString();
}

function capabilitiesFromBody(body: unknown): BaseMcpStatus['capabilities'] | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const obj = body as Record<string, unknown>;
  const rawCaps = obj.capabilities && typeof obj.capabilities === 'object'
    ? obj.capabilities as Record<string, unknown>
    : obj;

  const toolsRaw = rawCaps.toolsCount ?? rawCaps.tools_count;
  const resourcesRaw = rawCaps.resourcesCount ?? rawCaps.resources_count;
  const toolsCount = typeof toolsRaw === 'number'
    ? toolsRaw
    : Array.isArray(obj.tools)
      ? obj.tools.length
      : undefined;
  const resourcesCount = typeof resourcesRaw === 'number'
    ? resourcesRaw
    : Array.isArray(obj.resources)
      ? obj.resources.length
      : undefined;

  if (toolsCount === undefined && resourcesCount === undefined) return undefined;
  return {
    toolsCount,
    resourcesCount,
  };
}

async function readJsonSafe(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

function classifyError(err: unknown): string {
  const e = err as { name?: string; code?: string; message?: string } | null | undefined;
  if (e?.name === 'AbortError' || e?.code === 'ABORT_ERR' || /timeout|aborted/i.test(e?.message || '')) {
    return 'timeout';
  }
  return 'network_error';
}

export function getBaseMcpStatusSnapshot(): BaseMcpStatus {
  const staticResult = staticStatus();
  if (staticResult) return staticResult;

  const key = configKey();
  if (cached && cached.configKey === key) return cached.status;

  const base = baseStatus();
  if (!('endpoint' in base)) return base;
  return {
    ...base.status,
    status: 'unreachable',
  };
}

export async function probeBaseMcpStatus(): Promise<BaseMcpStatus> {
  const staticResult = staticStatus();
  if (staticResult) return staticResult;

  const key = configKey();
  const now = Date.now();
  if (cached && cached.configKey === key && cached.expiresAt > now) {
    return cached.status;
  }
  if (inflight) return inflight;

  const base = baseStatus();
  if (!('endpoint' in base)) return base;

  inflight = (async () => {
    const checkedAt = new Date().toISOString();
    const timeoutMs = timeoutFromEnv();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(statusUrl(base.endpoint), {
        method: 'GET',
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      clearTimeout(timer);

      const common = {
        ...base.status,
        lastCheckedAt: checkedAt,
      };
      let status: BaseMcpStatus;
      if (res.status === 429) {
        status = { ...common, status: 'degraded', errorCode: 'rate_limited' };
      } else if (res.ok) {
        const body = await readJsonSafe(res);
        status = { ...common, status: 'connected', capabilities: capabilitiesFromBody(body) };
      } else if (res.status === 404 || res.status === 405) {
        status = { ...common, status: 'missing', errorCode: `http_${res.status}` };
      } else {
        status = { ...common, status: 'degraded', errorCode: `http_${res.status}` };
      }

      const ttl = status.status === 'connected' ? SUCCESS_TTL_MS : FAILURE_COOLDOWN_MS;
      cached = { configKey: key, status, expiresAt: Date.now() + ttl };
      return status;
    } catch (err) {
      clearTimeout(timer);
      const status: BaseMcpStatus = {
        ...base.status,
        status: 'unreachable',
        lastCheckedAt: checkedAt,
        errorCode: classifyError(err),
      };
      cached = { configKey: key, status, expiresAt: Date.now() + FAILURE_COOLDOWN_MS };
      return status;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

export function recordBaseMcpToolProbe(input: {
  endpointHost: string;
  toolsCount: number;
  capabilities?: {
    readOnly: number;
    userConfirmedTransaction: number;
    forbidden: number;
    unknown: number;
  };
  checkedAt: string;
}): void {
  toolProbe = {
    configKey: configKey(),
    endpointHost: input.endpointHost,
    toolsCount: input.toolsCount,
    readOnlyToolsCount: input.capabilities?.readOnly ?? 0,
    transactionToolsCount: input.capabilities?.userConfirmedTransaction ?? 0,
    forbiddenToolsCount: input.capabilities?.forbidden ?? 0,
    unknownToolsCount: input.capabilities?.unknown ?? 0,
    checkedAt: input.checkedAt,
  };
}

export function attachBaseMcpToolProbeStatus(base: BaseMcpStatus): BaseMcpStatus {
  if (!toolProbe || toolProbe.configKey !== configKey()) return base;
  if (!base.endpointHost || base.endpointHost !== toolProbe.endpointHost) return base;
  if (!base.enabled || !base.configured) return base;
  return {
    ...base,
    toolsCount: toolProbe.toolsCount,
    readOnlyToolsCount: toolProbe.readOnlyToolsCount,
    transactionToolsCount: toolProbe.transactionToolsCount,
    forbiddenToolsCount: toolProbe.forbiddenToolsCount,
    unknownToolsCount: toolProbe.unknownToolsCount,
    lastToolProbeAt: toolProbe.checkedAt,
  };
}

export function finalizeBaseMcpReadiness(base: BaseMcpStatus): BaseMcpStatus {
  if (!base.configured) return { ...base, readiness: 'not_configured', usable: false };
  if (!base.enabled) return { ...base, readiness: 'configured', usable: false };
  if (base.auth?.needsReauth || (!base.auth?.connected && base.status === 'needs_reauth')) {
    return { ...base, status: 'needs_reauth', readiness: 'configured', usable: false };
  }

  if (base.auth?.connected && base.auth.expired) {
    return {
      ...base,
      status: 'degraded',
      readiness: 'oauth_connected',
      usable: false,
      errorCode: base.errorCode || 'oauth_token_expired',
    };
  }

  const toolsCount = base.toolsCount;
  if (base.auth?.connected && typeof toolsCount === 'number' && toolsCount > 0) {
    return { ...base, status: 'connected', readiness: 'tools_available', usable: true };
  }
  if (base.auth?.connected && toolsCount === 0) {
    return {
      ...base,
      status: 'degraded',
      readiness: 'oauth_connected',
      usable: false,
      errorCode: base.errorCode || 'no_tools_available',
    };
  }
  if (base.status === 'unreachable' || base.status === 'degraded' || base.status === 'unsupported') {
    return { ...base, readiness: 'degraded', usable: false };
  }
  if (base.auth?.connected) {
    return {
      ...base,
      status: 'degraded',
      readiness: 'oauth_connected',
      usable: false,
      errorCode: base.errorCode || 'tool_inventory_unverified',
    };
  }
  return { ...base, readiness: 'configured', usable: false };
}

export function clearBaseMcpStatusForTests(): void {
  cached = null;
  inflight = null;
  toolProbe = null;
}
