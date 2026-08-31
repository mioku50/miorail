import {
  type McpClientKindV1,
  type McpExecutionAuditV1,
  type McpHandoffRevocationV1,
} from './mcpExecutionAudit.js';

// ---------------------------------------------------------------------------
// Connected Apps — the grants a wallet has handed out, derived rather than
// stored.
//
// A handoff grant has no table of its own and does not need one. Its whole life
// is already written down: the `token_issued` audit row is where it began, every
// later row with the same `token_id` is a use, and `mcp_handoff_revocations`
// says whether it ended. A second table would be a second opinion about the
// same events, and the two would eventually disagree.
//
// FOUR THINGS THIS PROJECTION REFUSES TO SAY
//
//   1. That a grant is "active". Nothing here knows: a handoff token carries
//      its own expiry, signed, and the server stores neither the expiry nor
//      the token. What is knowable is whether it was REVOKED, so that is what
//      is reported, and the surface says out loud that tokens also lapse on
//      their own.
//
//   2. That issuing is using. `token_issued` is excluded from `lastUsedAt` and
//      from `useCount`. A grant minted and never touched must read as never
//      used, because that is exactly the one an owner wants to revoke.
//
//   3. When a grant began, if the row that says so is not in the window. The
//      audit query is bounded, so an old grant can surface through its recent
//      activity alone. `issuedAt` is then null and `historyComplete` is false —
//      never the oldest row we happen to hold, which would date the grant to
//      whenever the page was last busy.
//
//   4. Which client a grant belongs to, when nothing recorded one. Every row
//      written before this existed has `clientKind: null`, and null is "not
//      recorded" — never `other`, which means a client the user named.
// ---------------------------------------------------------------------------

/** The browser's own session is not a grant. It authenticates as a cookie, it
 * is not handed to anybody, and there is nothing to revoke. */
export const MCP_SESSION_TOKEN_ID_V1 = 'session';

export interface McpHandoffGrantV1 {
  tokenId: string;
  /** Null when the grant predates Connected Apps, or was issued without one. */
  clientKind: McpClientKindV1 | null;
  walletAddress: string;
  /** Null when the issuance row is outside the queried window. */
  issuedAt: string | null;
  /** Null when the grant has never been used for anything but its own minting. */
  lastUsedAt: string | null;
  /** Calls made with this grant. Issuance is not one of them. */
  useCount: number;
  revokedAt: string | null;
  /** False when the issuance row was not in the window, so counts and dates
   * describe the window rather than the grant's whole life. */
  historyComplete: boolean;
}

/**
 * Group an audit window and a revocation list into one row per grant.
 *
 * Ordered by the most recent thing that happened to each grant, because that
 * is the order an owner scans in when deciding what to revoke. A revocation
 * counts as something that happened: a grant revoked a minute ago belongs at
 * the top, not buried under one last used a week ago.
 */
export function mcpHandoffGrantsV1(input: {
  audit: readonly McpExecutionAuditV1[];
  revocations: readonly McpHandoffRevocationV1[];
}): McpHandoffGrantV1[] {
  const revokedAt = new Map<string, string>();
  for (const revocation of input.revocations) {
    const existing = revokedAt.get(revocation.tokenId);
    // The earliest revocation is the one that took effect; a second is a no-op
    // against a grant that was already gone.
    if (!existing || revocation.revokedAt < existing) {
      revokedAt.set(revocation.tokenId, revocation.revokedAt);
    }
  }

  const byToken = new Map<string, McpHandoffGrantV1>();
  for (const row of input.audit) {
    if (row.tokenId === MCP_SESSION_TOKEN_ID_V1) continue;
    const grant = byToken.get(row.tokenId) ?? {
      tokenId: row.tokenId,
      clientKind: null,
      walletAddress: row.walletAddress,
      issuedAt: null,
      lastUsedAt: null,
      useCount: 0,
      revokedAt: revokedAt.get(row.tokenId) ?? null,
      historyComplete: false,
    };

    if (row.outcome === 'token_issued') {
      grant.issuedAt = row.createdAt;
      grant.historyComplete = true;
      // The client is recorded at issuance and nowhere else, so this row is
      // the only one that can carry it.
      if (row.clientKind !== null) grant.clientKind = row.clientKind;
    } else {
      grant.useCount += 1;
      if (grant.lastUsedAt === null || row.createdAt > grant.lastUsedAt) {
        grant.lastUsedAt = row.createdAt;
      }
    }

    byToken.set(row.tokenId, grant);
  }

  // A grant can be revoked and have no audit row in the window at all. It is
  // still a grant the owner acted on, and dropping it would make a revocation
  // disappear from the list that reports revocations.
  for (const revocation of input.revocations) {
    if (byToken.has(revocation.tokenId)) continue;
    if (revocation.tokenId === MCP_SESSION_TOKEN_ID_V1) continue;
    byToken.set(revocation.tokenId, {
      tokenId: revocation.tokenId,
      clientKind: null,
      walletAddress: '',
      issuedAt: null,
      lastUsedAt: null,
      useCount: 0,
      revokedAt: revocation.revokedAt,
      historyComplete: false,
    });
  }

  const activityOf = (grant: McpHandoffGrantV1): string =>
    [grant.revokedAt, grant.lastUsedAt, grant.issuedAt]
      .filter((value): value is string => value !== null)
      .sort()
      .at(-1) ?? '';

  return [...byToken.values()].sort((left, right) => {
    const l = activityOf(left);
    const r = activityOf(right);
    if (l === r) return left.tokenId < right.tokenId ? -1 : 1;
    return l < r ? 1 : -1;
  });
}
