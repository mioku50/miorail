// T48b: bounded TTL cache for the live Base MCP `listTools()` inventory.
// Before this cache, `listDynamicBaseMcpToolsFromClient` re-ran a full
// (possibly paginated) `listTools()` call against mcp.base.org on every
// chat turn (factory.ts, baseMcpTools.ts). The cache key is
// (userId, oauth-token-version) so a token refresh/reconnect always busts the
// cache, and it never substitutes stale data past its TTL — a cache miss
// simply re-lists live. This cache covers inventory discovery ONLY: the
// per-write wallet-match recheck (verifyBaseMcpWalletMatch in
// artifacts/api-server/routes/chat.ts) still runs on every message and is
// untouched by this module.

import { listDynamicBaseMcpToolsFromClient, type DynamicBaseMcpTool } from './dynamic_base_mcp.js';

type BaseMcpCallClient = Parameters<typeof listDynamicBaseMcpToolsFromClient>[0];

interface CacheEntry {
  tools: DynamicBaseMcpTool[];
  expiresAt: number;
}

const DEFAULT_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

export function dynamicBaseMcpCacheKey(userId: string, oauthTokenVersion?: string): string {
  return `${userId}:${oauthTokenVersion ?? 'default'}`;
}

export interface DynamicToolsCacheDeps {
  now?: () => number;
  ttlMs?: number;
}

/**
 * Cached wrapper around `listDynamicBaseMcpToolsFromClient`. A cache hit
 * returns the previously classified tool list without calling `listTools()`
 * again; a miss (first call, TTL expired, or a different oauth-token-version
 * key) lists live and refreshes the entry.
 */
export async function listDynamicBaseMcpToolsCached(
  client: BaseMcpCallClient,
  key: string,
  toggles?: Record<string, boolean>,
  deps: DynamicToolsCacheDeps = {},
): Promise<DynamicBaseMcpTool[]> {
  const now = (deps.now ?? Date.now)();
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.tools;

  const tools = await listDynamicBaseMcpToolsFromClient(client, toggles);
  cache.set(key, { tools, expiresAt: now + ttlMs });
  return tools;
}

export function clearDynamicBaseMcpToolsCacheForTests(): void {
  cache.clear();
}
