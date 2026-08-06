import type { Request } from 'express';
import { getMiorailProductMigrationFlags } from '../../lib/productMigrationConfig.js';
import { isTokenRevokedV1 } from './audit.js';
import {
  MCP_HANDOFF_REFUSAL_COPY_V1,
  bearerTokenV1,
  verifyHandoffTokenV1,
  type McpHandoffRefusalV1,
} from '../../lib/mcpHandoffToken.js';

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
  source: 'handoff_token' | 'browser_session';
}

export type McpPrivateAuthRefusalV1 =
  | McpHandoffRefusalV1
  | 'mcp_private_disabled'
  | 'handoff_token_revoked';

export const MCP_PRIVATE_AUTH_COPY_V1: Record<McpPrivateAuthRefusalV1, string> = {
  ...MCP_HANDOFF_REFUSAL_COPY_V1,
  mcp_private_disabled:
    'This Miorail server does not expose the private MCP surface. Only the public read-only tools at /mcp are available here.',
  // §3 — deliberately distinct from expiry. "It ran out" and "somebody turned
  // it off" are different events, and a user who revoked a token needs to see
  // that the revocation is what stopped it.
  handoff_token_revoked:
    'That handoff token was revoked. Issue a new one from Miorail if you still want an assistant connected.',
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
