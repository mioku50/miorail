import type { Request } from 'express';
import { getMiorailProductMigrationFlags } from '../../lib/productMigrationConfig.js';
import { isTokenRevokedV1 } from './audit.js';
import {
  MCP_HANDOFF_REFUSAL_COPY_V1,
  bearerTokenV1,
  verifyHandoffTokenV1,
  type McpHandoffRefusalV1,
} from '../../lib/mcpHandoffToken.js';
import { mcpOAuthProviderV1 } from '../../lib/mcpOAuthProvider.js';
import { MCP_OAUTH_GRANT_ID_PREFIX_V1 } from '@mioagent/route-storage';

// ---------------------------------------------------------------------------
// T72-B §1/§10 — who is calling.
//
// Two accepted proofs, and no third:
//
//   * a handoff token, minted by a browser session that had already proved the
//     wallet, sent as `Authorization: Bearer`;
//   * the browser session itself, for a caller that happens to have one.
//
// What is NOT accepted is a wallet address. There is no header, argument or
// body field on this surface by which a caller names the wallet it wants to
// act as — the wallet is read out of the proof, and a caller with no proof
// gets nothing. §10's "no wallet address accepted without authenticated
// ownership" is therefore not a check that could be forgotten; it is the
// absence of a parameter.
// ---------------------------------------------------------------------------

export interface McpPrivateIdentityV1 {
  tenantId: string;
  walletAddress: `0x${string}`;
  chainId: 8453;
  /** For audit lines. `session` when the caller had a cookie instead. */
  tokenId: string;
  source: 'handoff_token' | 'oauth' | 'browser_session';
}

export type McpPrivateAuthRefusalV1 =
  | McpHandoffRefusalV1
  | 'mcp_private_disabled'
  | 'handoff_token_revoked'
  | 'oauth_token_invalid';

export const MCP_PRIVATE_AUTH_COPY_V1: Record<McpPrivateAuthRefusalV1, string> = {
  ...MCP_HANDOFF_REFUSAL_COPY_V1,
  mcp_private_disabled:
    'This Miorail server does not expose the private MCP surface. Only the public read-only tools at /mcp are available here.',
  // §3 — deliberately distinct from expiry. "It ran out" and "somebody turned
  // it off" are different events, and a user who revoked a token needs to see
  // that the revocation is what stopped it.
  handoff_token_revoked:
    'That handoff token was revoked. Issue a new one from Miorail if you still want an assistant connected.',
  oauth_token_invalid:
    'That Miorail OAuth access token is expired, invalid or revoked. The client should refresh it or ask you to authorize again.',
};

export type McpPrivateAuthV1 =
  | { ok: true; identity: McpPrivateIdentityV1 }
  | { ok: false; reason: McpPrivateAuthRefusalV1 };

export const mcpPrivateAuthRuntime = {
  flags: getMiorailProductMigrationFlags,
  now: () => new Date(),
  isRevoked: isTokenRevokedV1,
};

function sessionIdentityV1(req: Request): McpPrivateIdentityV1 | null {
  const user = req.session?.user;
  if (!user) return null;
  // The same strict shape the B20 routes require. The permissive dev
  // single-user path is deliberately not honoured here: it lets a wallet come
  // from a request body, which is the one thing this surface must never allow.
  if (user.chainId !== 8453) return null;
  if (!/^0x[0-9a-f]{40}$/.test(user.address)) return null;
  if (user.id !== `eip155:8453:${user.address}`) return null;
  return {
    tenantId: user.id,
    walletAddress: user.address,
    chainId: 8453,
    tokenId: 'session',
    source: 'browser_session',
  };
}

export async function resolvePrivateIdentityV1(req: Request): Promise<McpPrivateAuthV1> {
  const flags = mcpPrivateAuthRuntime.flags(process.env);
  if (!flags.routeIntelligenceV1 || !flags.b20ControlV1 || !flags.mcpPrivateV1) {
    return { ok: false, reason: 'mcp_private_disabled' };
  }

  const token = bearerTokenV1(req.headers.authorization);
  if (token) {
    if (token.startsWith('miorail_oauth_access_')) {
      try {
        const auth = await mcpOAuthProviderV1.verifyAccessToken(token);
        const extra = auth.extra ?? {};
        const tenantId = typeof extra.tenantId === 'string' ? extra.tenantId : '';
        const walletAddress = typeof extra.walletAddress === 'string' ? extra.walletAddress : '';
        const grantId = typeof extra.grantId === 'string' ? extra.grantId : '';
        if (
          !auth.scopes.includes('miorail:connected') ||
          !/^eip155:8453:0x[0-9a-f]{40}$/.test(tenantId) ||
          !/^0x[0-9a-f]{40}$/.test(walletAddress) ||
          tenantId !== `eip155:8453:${walletAddress}` ||
          !grantId.startsWith(MCP_OAUTH_GRANT_ID_PREFIX_V1)
        ) {
          return { ok: false, reason: 'oauth_token_invalid' };
        }
        return {
          ok: true,
          identity: {
            tenantId,
            walletAddress: walletAddress as `0x${string}`,
            chainId: 8453,
            // The DURABLE grant, never the access token's own id. An access
            // token is replaced every fifteen minutes, so auditing under it
            // would file one connection as a new anonymous grant every time it
            // refreshed, and would reset the per-caller rate limit with it.
            tokenId: grantId,
            source: 'oauth',
          },
        };
      } catch {
        return { ok: false, reason: 'oauth_token_invalid' };
      }
    }
    const secret = (process.env.SESSION_SECRET ?? '').trim();
    if (!secret) return { ok: false, reason: 'handoff_token_bad_signature' };
    const verified = verifyHandoffTokenV1({ token, secret, now: mcpPrivateAuthRuntime.now() });
    if (!verified.ok) return { ok: false, reason: verified.reason };
    // §3 — checked after the signature and before the identity is used for
    // anything. A revocation lookup on an unverified token would be a lookup
    // on an attacker-chosen key.
    if (
      await mcpPrivateAuthRuntime.isRevoked({
        tokenId: verified.claims.tokenId,
        tenantId: verified.claims.tenantId,
      })
    ) {
      return { ok: false, reason: 'handoff_token_revoked' };
    }
    return {
      ok: true,
      identity: {
        tenantId: verified.claims.tenantId,
        walletAddress: verified.claims.walletAddress,
        chainId: 8453,
        tokenId: verified.claims.tokenId,
        source: 'handoff_token',
      },
    };
  }

  // A bearer header that was present but unparseable never reaches here — it
  // is refused above — so falling through means no credential was offered at
  // all, and the session is the only remaining proof.
  const fromSession = sessionIdentityV1(req);
  if (fromSession) return { ok: true, identity: fromSession };
  return { ok: false, reason: 'handoff_token_missing' };
}
