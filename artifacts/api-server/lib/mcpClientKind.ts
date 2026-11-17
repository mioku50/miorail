import type { LendingOriginV1 } from './lendingDraft.js';

// ---------------------------------------------------------------------------
// Which assistant a connected MCP client is, for a Loop's "Done in Claude".
//
// A client's name is its own claim: dynamic registration lets anybody call a
// client "Claude". Where its authorization codes go is not: only Claude,
// ChatGPT and Grok can receive a code at claude.ai, chatgpt.com or grok.com.
// So a client counts as one of them only when EVERY redirect it registered is
// on that assistant's own host over https. A client that also registered any
// other address could have used that one instead, and proves nothing; a CLI
// on localhost (Codex, Claude Code) stays "other".
//
// Production on 2026-11-17 held authorization codes for claude.ai, chatgpt.com,
// grok.com and loopback addresses only.
// ---------------------------------------------------------------------------

export type McpClientKindV1 = LendingOriginV1['client'];

// A Map, not an object: a host named "constructor" must find nothing.
const HOSTS_V1: ReadonlyMap<string, McpClientKindV1> = new Map([
  ['claude.ai', 'claude'],
  ['claude.com', 'claude'],
  ['chatgpt.com', 'chatgpt'],
  ['chat.openai.com', 'chatgpt'],
  ['grok.com', 'grok'],
]);

export function mcpClientKindOfRedirectsV1(redirectUris: readonly unknown[] | undefined): McpClientKindV1 {
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) return 'other';
  const kinds = new Set<McpClientKindV1>();
  for (const uri of redirectUris) {
    let url: URL;
    try {
      url = new URL(String(uri));
    } catch {
      return 'other';
    }
    const kind = url.protocol === 'https:' && url.port === '' ? HOSTS_V1.get(url.hostname.toLowerCase()) : undefined;
    if (!kind) return 'other';
    kinds.add(kind);
  }
  return kinds.size === 1 ? [...kinds][0]! : 'other';
}

type RegisteredClientV1 = { redirect_uris?: readonly unknown[] } | undefined;
/** The OAuth store's own shape: the SDK lets it answer at once or later. */
export interface McpClientStoreV1 {
  getClient(clientId: string): RegisteredClientV1 | Promise<RegisteredClientV1>;
}

/** The assistant behind an OAuth client id, or "other" when it cannot be shown. Never throws: a failed
 * read only loses the label, never the loan. */
export async function mcpClientKindV1(clientId: string | undefined, store: McpClientStoreV1): Promise<McpClientKindV1> {
  if (!clientId) return 'other';
  try {
    const client = await store.getClient(clientId);
    return client ? mcpClientKindOfRedirectsV1(client.redirect_uris) : 'other';
  } catch {
    return 'other';
  }
}
