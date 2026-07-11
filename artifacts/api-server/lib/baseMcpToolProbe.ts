import {
  BaseMcpClient,
  createBaseMcpHttpTransport,
  type BaseMcpOAuthProvider,
  type Transport,
} from '@mioagent/mcp';
import {
  baseMcpEnabledFromEnv,
  baseMcpServerUrlFromEnv,
  recordBaseMcpToolProbe,
} from './baseMcpStatus.js';
import {
  createBaseMcpOAuthProviderForUser,
  getBaseMcpAuthStatus,
  markBaseMcpNeedsReauth,
} from './baseMcpOAuthStore.js';
import { refreshBaseMcpOAuthIfNeeded } from './baseMcpOAuthLifecycle.js';
import {
  classifyBaseMcpTools,
  emptyBaseMcpToolCapabilityCounts,
  type BaseMcpToolCapabilityCounts,
  type ClassifiedBaseMcpTool,
} from './baseMcpToolClassifier.js';

export type BaseMcpToolProbeStatus = 'connected' | 'needs_reauth' | 'unreachable' | 'degraded';

export interface BaseMcpToolInventoryItem {
  name: string;
  description?: string;
}

export interface BaseMcpToolProbeResult {
  status: BaseMcpToolProbeStatus;
  endpointHost?: string;
  toolsCount: number;
  capabilities: BaseMcpToolCapabilityCounts;
  tools: ClassifiedBaseMcpTool[];
  checkedAt: string;
  errorCode?: string;
}

type MinimalMcpClient = {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
  getClient(): {
    listTools(params?: { cursor?: string }): Promise<{
      tools?: unknown[];
      nextCursor?: string;
    }>;
  };
};

export const baseMcpToolProbeRuntime = {
  getBaseMcpAuthStatus,
  markBaseMcpNeedsReauth,
  createOAuthProvider: createBaseMcpOAuthProviderForUser,
  refreshOAuthIfNeeded: refreshBaseMcpOAuthIfNeeded,
  createClient: (): MinimalMcpClient => new BaseMcpClient(),
  createTransport: (serverUrl: URL, oauthProvider: BaseMcpOAuthProvider): Transport =>
    createBaseMcpHttpTransport(serverUrl, oauthProvider),
};

function timeoutMsFromEnv(): number {
  const parsed = Number(process.env.BASE_MCP_TIMEOUT_MS || 2500);
  if (!Number.isFinite(parsed) || parsed <= 0) return 2500;
  return Math.min(parsed, 30_000);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error('timeout');
      error.name = 'AbortError';
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sanitizeText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.slice(0, maxLength);
}

function sanitizeTool(raw: unknown): BaseMcpToolInventoryItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const name = sanitizeText(obj.name, 120);
  if (!name) return null;
  const description = sanitizeText(obj.description, 500);
  return description ? { name, description } : { name };
}

function classifyProbeError(error: unknown): { status: BaseMcpToolProbeStatus; errorCode: string } {
  const e = error as { name?: string; code?: string; message?: string; status?: number } | null | undefined;
  const message = e?.message || '';
  const code = e?.code || '';
  const status = e?.status;

  if (
    status === 401 ||
    status === 403 ||
    /401|403|unauthori[sz]ed|invalid_grant|invalid token|reauth|authorization|authenticate data|decrypt|credential/i.test(message)
  ) {
    const credentialsInvalid = /authenticate data|decrypt|credential/i.test(message);
    return { status: 'needs_reauth', errorCode: credentialsInvalid ? 'credentials_invalid' : 'authorization_failed' };
  }

  if (
    e?.name === 'AbortError' ||
    code === 'ABORT_ERR' ||
    /timeout|aborted|fetch failed|network|ECONNRESET|ENOTFOUND|ECONNREFUSED/i.test(message)
  ) {
    return { status: 'unreachable', errorCode: e?.name === 'AbortError' ? 'timeout' : 'network_error' };
  }

  return { status: 'degraded', errorCode: 'tool_probe_failed' };
}

async function listAllTools(client: MinimalMcpClient): Promise<BaseMcpToolInventoryItem[]> {
  const tools: BaseMcpToolInventoryItem[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < 10; page += 1) {
    const response = await client.getClient().listTools(cursor ? { cursor } : undefined);
    const pageTools = Array.isArray(response.tools) ? response.tools : [];
    for (const raw of pageTools) {
      const tool = sanitizeTool(raw);
      if (tool) tools.push(tool);
    }
    cursor = typeof response.nextCursor === 'string' && response.nextCursor ? response.nextCursor : undefined;
    if (!cursor) break;
  }

  return tools;
}

export async function probeBaseMcpTools(input: {
  userId: string;
  sessionSecret: string;
  redirectUrl: string;
}): Promise<BaseMcpToolProbeResult> {
  const checkedAt = new Date().toISOString();
  const serverUrl = baseMcpServerUrlFromEnv();
  const endpointHost = serverUrl?.host;

  if (!baseMcpEnabledFromEnv() || !serverUrl) {
    return {
      status: 'degraded',
      endpointHost,
      toolsCount: 0,
      capabilities: emptyBaseMcpToolCapabilityCounts(),
      tools: [],
      checkedAt,
      errorCode: 'missing_config',
    };
  }

  const auth = await baseMcpToolProbeRuntime
    .getBaseMcpAuthStatus(input.userId)
    .catch(() => ({
      connected: false,
      needsReauth: true,
      userScoped: true as const,
      expired: false,
      expiresAt: undefined,
    }));
  if (!auth.connected) {
    return {
      status: 'needs_reauth',
      endpointHost,
      toolsCount: 0,
      capabilities: emptyBaseMcpToolCapabilityCounts(),
      tools: [],
      checkedAt,
      errorCode: 'needs_reauth',
    };
  }

  const expiresAt = auth.expiresAt ? Date.parse(auth.expiresAt) : Number.POSITIVE_INFINITY;
  if (auth.expired || (Number.isFinite(expiresAt) && expiresAt <= Date.now() + 5 * 60 * 1000)) {
    const refresh = await baseMcpToolProbeRuntime.refreshOAuthIfNeeded({
      userId: input.userId,
      sessionSecret: input.sessionSecret,
      redirectUrl: input.redirectUrl,
      serverUrl,
    });
    if (refresh.status === 'needs_reauth') {
      return {
        status: 'needs_reauth',
        endpointHost,
        toolsCount: 0,
        capabilities: emptyBaseMcpToolCapabilityCounts(),
        tools: [],
        checkedAt,
        errorCode: refresh.errorCode,
      };
    }
  }

  const oauthProvider = baseMcpToolProbeRuntime.createOAuthProvider({
    userId: input.userId,
    sessionSecret: input.sessionSecret,
    redirectUrl: input.redirectUrl,
  });
  const client = baseMcpToolProbeRuntime.createClient();

  try {
    await withTimeout(
      client.connect(baseMcpToolProbeRuntime.createTransport(serverUrl, oauthProvider)),
      timeoutMsFromEnv(),
    );
    const tools = await withTimeout(listAllTools(client), timeoutMsFromEnv());
    const classified = classifyBaseMcpTools(tools);
    const result: BaseMcpToolProbeResult = {
      status: classified.tools.length > 0 ? 'connected' : 'degraded',
      endpointHost,
      toolsCount: classified.tools.length,
      capabilities: classified.capabilities,
      tools: classified.tools,
      checkedAt,
      ...(classified.tools.length > 0 ? {} : { errorCode: 'no_tools_available' }),
    };
    if (endpointHost) {
      recordBaseMcpToolProbe({
        endpointHost,
        toolsCount: classified.tools.length,
        capabilities: classified.capabilities,
        checkedAt,
      });
    }
    return result;
  } catch (error) {
    const classified = classifyProbeError(error);
    if (classified.status === 'needs_reauth') {
      await baseMcpToolProbeRuntime
        .markBaseMcpNeedsReauth({ userId: input.userId, error: classified.errorCode })
        .catch(() => undefined);
    }
    return {
      status: classified.status,
      endpointHost,
      toolsCount: 0,
      capabilities: emptyBaseMcpToolCapabilityCounts(),
      tools: [],
      checkedAt,
      errorCode: classified.errorCode,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
