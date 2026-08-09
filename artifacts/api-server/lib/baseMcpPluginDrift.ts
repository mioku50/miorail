import { BASE_MCP_PLUGIN_CATALOGUE_V1 } from '@mioagent/security';

// ---------------------------------------------------------------------------
// Has our plugin catalogue fallen behind Base's?
//
// The catalogue itself is committed, and stays committed: it carries the host
// allowlist, and an allowlist that refreshes itself from the network is one
// nobody reviews. But a committed catalogue silently rots, and the user asked
// the right question — if Base adds a plugin, will this project show it?
//
// So the check reads NAMES and nothing else. A name cannot widen an allowlist,
// cannot add a host, and cannot become a request; it can only tell the surface
// that the file is N plugins behind, which is the honest thing to display.
// Adopting a new plugin is still a diff someone reads, produced by
// `scripts/refreshBaseMcpPluginCatalogue.mts`.
//
// The failure mode this is written against: a fetch that fails must never be
// reported as "in sync", and a source that answers with an empty list must
// never be reported as "Base removed every plugin". Both are `unchecked`, with
// the reason named. That confusion — our own outage wearing the subject's name
// — has shipped here three times, and it does not ship again.
// ---------------------------------------------------------------------------

/** Public, unauthenticated, and deliberately not configurable: a settable
 * source URL is how a "drift check" becomes an SSRF gadget. */
const CONTENTS_API_V1 =
  'https://api.github.com/repos/base/skills/contents/skills/base-mcp/plugins';

const SUCCESS_TTL_MS_V1 = 30 * 60 * 1000;
/** Shorter, so an outage neither hammers the source nor sticks all day. */
const FAILURE_TTL_MS_V1 = 5 * 60 * 1000;
const TIMEOUT_MS_V1 = 6000;

const PLUGIN_ID_V1 = /^[a-z0-9][a-z0-9-]{0,40}$/;

export type BaseMcpPluginDriftStatusV1 = 'in_sync' | 'drifted' | 'unchecked';

export interface BaseMcpPluginDriftV1 {
  status: BaseMcpPluginDriftStatusV1;
  /** Plugins in the committed catalogue. Always known. */
  knownCount: number;
  /** Plugins Base publishes right now, or null when the check did not run. */
  publishedCount: number | null;
  /** Published by Base, absent here — the ones a refresh would add. */
  added: string[];
  /** Here, no longer published by Base. */
  removed: string[];
  checkedAt: string | null;
  /** Why the check did not run. Null on a completed check. */
  reason: string | null;
}

interface CacheEntry {
  value: BaseMcpPluginDriftV1;
  expiresAt: number;
}

let cache: CacheEntry | null = null;

export const baseMcpPluginDriftRuntimeV1 = {
  fetchImpl: ((...args: Parameters<typeof fetch>) => fetch(...args)) as typeof fetch,
  now: () => Date.now(),
};

/** Set false to stop the outbound check entirely. The surface then says the
 * check is off rather than implying the catalogue is current. */
function driftCheckEnabledV1(): boolean {
  return String(process.env.BASE_MCP_PLUGIN_DRIFT_CHECK_V1 ?? 'true').trim().toLowerCase() !== 'false';
}

function knownIdsV1(): string[] {
  return BASE_MCP_PLUGIN_CATALOGUE_V1.map((plugin) => plugin.id).sort();
}

function uncheckedV1(reason: string): BaseMcpPluginDriftV1 {
  return {
    status: 'unchecked',
    knownCount: knownIdsV1().length,
    publishedCount: null,
    added: [],
    removed: [],
    checkedAt: null,
    reason,
  };
}

/**
 * The plugin ids Base publishes, or null when we could not tell.
 *
 * Ids are validated against a strict pattern before they go anywhere near a
 * response: this list is third-party text, and it ends up rendered.
 */
async function publishedPluginIdsV1(): Promise<string[] | null> {
  try {
    const response = await baseMcpPluginDriftRuntimeV1.fetchImpl(CONTENTS_API_V1, {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(TIMEOUT_MS_V1),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!Array.isArray(body)) return null;
    const ids = body
      .filter((entry): entry is { name: string } =>
        Boolean(entry) &&
        typeof entry === 'object' &&
        (entry as { type?: unknown }).type === 'file' &&
        typeof (entry as { name?: unknown }).name === 'string')
      .map((entry) => entry.name.replace(/\.md$/, ''))
      .filter((id) => PLUGIN_ID_V1.test(id));
    return [...new Set(ids)].sort();
  } catch {
    // Never the error's own message: a transport failure can carry the URL,
    // and a URL can carry a token.
    return null;
  }
}

export async function baseMcpPluginDriftV1(): Promise<BaseMcpPluginDriftV1> {
  if (!driftCheckEnabledV1()) return uncheckedV1('check_disabled');

  const now = baseMcpPluginDriftRuntimeV1.now();
  if (cache && cache.expiresAt > now) return cache.value;

  const known = knownIdsV1();
  const published = await publishedPluginIdsV1();

  if (published === null) {
    const value = uncheckedV1('source_unreachable');
    cache = { value, expiresAt: now + FAILURE_TTL_MS_V1 };
    return value;
  }
  if (published.length === 0) {
    // A source that answers with nothing is a source that answered wrong.
    // Reporting it as "Base removed all twenty plugins" would be our outage
    // wearing Base's name.
    const value = uncheckedV1('source_empty');
    cache = { value, expiresAt: now + FAILURE_TTL_MS_V1 };
    return value;
  }

  const added = published.filter((id) => !known.includes(id));
  const removed = known.filter((id) => !published.includes(id));
  const value: BaseMcpPluginDriftV1 = {
    status: added.length + removed.length === 0 ? 'in_sync' : 'drifted',
    knownCount: known.length,
    publishedCount: published.length,
    added,
    removed,
    checkedAt: new Date(now).toISOString(),
    reason: null,
  };
  cache = { value, expiresAt: now + SUCCESS_TTL_MS_V1 };
  return value;
}

/** Test seam. Production never calls this — the TTL is the only invalidation. */
export function resetBaseMcpPluginDriftCacheV1(): void {
  cache = null;
}
