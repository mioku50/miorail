import { abortableV1 } from '@mioagent/utils';
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
//
// What it keeps is the server's raw list, and the person's toggles are applied
// to it on every read (audit P3 Wallet MCP catalog, 2026-11-18). It kept the
// list already filtered by the toggles of its first read, under a key that does
// not name them, so a group switched on or off under the same OAuth connection
// took up to the TTL to show.

import {
  classifyDynamicBaseMcpTools,
  listRawDynamicBaseMcpToolsFromClient,
  type DynamicBaseMcpTool,
} from './dynamic_base_mcp.js';

type BaseMcpCallClient = Parameters<typeof listRawDynamicBaseMcpToolsFromClient>[0];

interface CacheEntry {
  rawTools: unknown[];
  expiresAt: number;
}

const DEFAULT_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

export function dynamicBaseMcpCacheKey(userId: string, oauthTokenVersion?: string): string {
  return `${userId}:${oauthTokenVersion ?? 'default'}`;
}

export interface DynamicToolsCacheDeps {
  signal?: AbortSignal;
  now?: () => number;
  ttlMs?: number;
}

/**
 * Cached wrapper around the live `listTools()` inventory. A cache hit
 * classifies the previously listed tools under the current toggles without
 * calling `listTools()` again; a miss (first call, TTL expired, or a different
 * oauth-token-version key) lists live and refreshes the entry.
 */
export async function listDynamicBaseMcpToolsCached(
  client: BaseMcpCallClient,
  key: string,
  toggles?: Record<string, boolean>,
  deps: DynamicToolsCacheDeps = {},
): Promise<DynamicBaseMcpTool[]> {
  deps.signal?.throwIfAborted();
  const now = (deps.now ?? Date.now)();
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return classifyDynamicBaseMcpTools(cached.rawTools, toggles);

  const rawTools = await abortableV1(deps.signal, () => listRawDynamicBaseMcpToolsFromClient(client, deps.signal));
  deps.signal?.throwIfAborted();
  cache.set(key, { rawTools, expiresAt: now + ttlMs });
  return classifyDynamicBaseMcpTools(rawTools, toggles);
}

export function clearDynamicBaseMcpToolsCacheForTests(): void {
  cache.clear();
}
