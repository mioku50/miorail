import { baseMcpPluginScopeV1, pluginScopedFetch } from '@mioagent/security/httpAllowlist';

const VIRTUALS_URL_V1 = 'https://mcp.acp.virtuals.io/';
const ALLOWED_METHODS_V1 = new Set(['login_start', 'login_complete', 'agent_list', 'agent_create']);

export type VirtualsReviewedMethodV1 = 'login_start' | 'login_complete' | 'agent_list' | 'agent_create';

export const virtualsReviewedClientRuntimeV1 = {
  fetch: pluginScopedFetch,
};

function parseJsonLayersV1(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 6 && typeof current === 'string'; depth += 1) {
    try { current = JSON.parse(current); } catch { break; }
  }
  return current;
}

function parseSseOrJsonV1(text: string): unknown {
  const frames = text
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== '[DONE]');
  const candidate = frames.at(-1) ?? text;
  return parseJsonLayersV1(candidate);
}

function unwrapMcpResultV1(value: unknown): { ok: true; data: unknown } | { ok: false; errorCode: string } {
  const parsed = parseJsonLayersV1(value);
  if (!parsed || typeof parsed !== 'object') return { ok: false, errorCode: 'virtuals_invalid_response' };
  const root = parsed as Record<string, unknown>;
  if (root.error) return { ok: false, errorCode: 'virtuals_rpc_error' };
  const result = parseJsonLayersV1(root.result);
  if (!result || typeof result !== 'object') return { ok: false, errorCode: 'virtuals_invalid_response' };
  const resultRecord = result as Record<string, unknown>;
  if (resultRecord.isError === true) return { ok: false, errorCode: 'virtuals_tool_error' };
  const content = resultRecord.content;
  if (!Array.isArray(content)) return { ok: true, data: result };
  const text = content
    .filter((part): part is Record<string, unknown> => Boolean(part) && typeof part === 'object')
    .map((part) => typeof part.text === 'string' ? part.text : '')
    .filter(Boolean)
    .join('\n');
  return text ? { ok: true, data: parseJsonLayersV1(text) } : { ok: true, data: result };
}

export async function callVirtualsReviewedV1(input: {
  method: VirtualsReviewedMethodV1;
  args: Record<string, unknown>;
}): Promise<{ ok: true; data: unknown } | { ok: false; errorCode: string }> {
  if (!ALLOWED_METHODS_V1.has(input.method)) return { ok: false, errorCode: 'virtuals_method_not_released' };
  const scope = baseMcpPluginScopeV1('virtuals');
  if (!scope || !scope.hosts.includes('mcp.acp.virtuals.io')) {
    return { ok: false, errorCode: 'virtuals_scope_unavailable' };
  }
  let response: Response;
  try {
    response = await virtualsReviewedClientRuntimeV1.fetch(
      { ...scope, methods: ['POST'], pathPrefixes: ['/'] },
      VIRTUALS_URL_V1,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: `miorail-${Date.now()}`,
          method: 'tools/call',
          params: { name: input.method, arguments: input.args },
        }),
      },
      { timeoutMs: 15_000 },
    );
  } catch {
    return { ok: false, errorCode: 'virtuals_unreachable' };
  }
  if (response.status === 401 || response.status === 403) return { ok: false, errorCode: 'virtuals_session_expired' };
  if (!response.ok) return { ok: false, errorCode: `virtuals_http_${response.status}` };
  try {
    return unwrapMcpResultV1(parseSseOrJsonV1(await response.text()));
  } catch {
    return { ok: false, errorCode: 'virtuals_invalid_response' };
  }
}

export function firstStringFieldV1(value: unknown, keys: readonly string[], depth = 0): string | null {
  const parsed = parseJsonLayersV1(value);
  if (depth > 8 || !parsed || typeof parsed !== 'object') return null;
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const found = firstStringFieldV1(item, keys, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const record = parsed as Record<string, unknown>;
  for (const key of keys) {
    const direct = record[key];
    if (typeof direct === 'string' && direct.trim()) return direct;
  }
  for (const item of Object.values(record)) {
    const found = firstStringFieldV1(item, keys, depth + 1);
    if (found) return found;
  }
  return null;
}
