import { Router, type Request, type Response } from 'express';
import { logger } from '@mioagent/utils';
import { getMiorailProductMigrationFlags } from '../lib/productMigrationConfig.js';
import {
  handoffTtlMsV1,
  issueHandoffTokenV1,
} from '../lib/mcpHandoffToken.js';
import { tenantUserFromRequest } from '../middleware/tenantAuth';

// ---------------------------------------------------------------------------
// T72-B §1 — where a handoff token comes from.
//
// Mounted INSIDE the tenant gate, which is the entire design: the only way to
// obtain a credential for the private MCP surface is to already be signed in
// with the wallet it will be bound to. Nothing here accepts a wallet address,
// so there is no request shape that mints a token for somebody else.
//
// The token is returned once and never stored. A user who loses it issues
// another; there is no endpoint that reads back an outstanding one, because a
// bearer credential that can be re-read is a bearer credential that leaks
// twice.
// ---------------------------------------------------------------------------

export const mcpHandoffRouter = Router();

export const mcpHandoffRuntime = {
  flags: getMiorailProductMigrationFlags,
  now: () => new Date(),
  ttlMs: handoffTtlMsV1,
  issue: issueHandoffTokenV1,
};

function sessionSecretV1(): string | null {
  const secret = (process.env.SESSION_SECRET ?? '').trim();
  return secret.length > 0 ? secret : null;
}

/**
 * The strict identity, not the permissive one.
 *
 * `tenantWalletAddress` deliberately lets the dev single-user mode take a
 * wallet from the request body, which is right for local work and wrong here:
 * a token minted from a body parameter would be a token minted for a wallet
 * that never authenticated. So this route reads the session user directly and
 * refuses anything that is not a real SIWE tenant.
 */
function signedInWalletV1(req: Request): { tenantId: string; walletAddress: string } | null {
  const user = tenantUserFromRequest(req);
  if (!user) return null;
  if (user.chainId !== 8453) return null;
  if (!/^0x[0-9a-f]{40}$/.test(user.address)) return null;
  if (user.id !== `eip155:8453:${user.address}`) return null;
  return { tenantId: user.id, walletAddress: user.address };
}

mcpHandoffRouter.get('/', (req: Request, res: Response) => {
  const flags = mcpHandoffRuntime.flags(process.env);
  const identity = signedInWalletV1(req);
  res.json({
    available: flags.mcpPrivateV1 && Boolean(sessionSecretV1()),
    executionAvailable: flags.mcpPrivateV1 && flags.mcpPrivateExecutionV1,
    // Stated so a surface can tell the user how long a token will last before
    // they paste it into a client config, rather than after it stops working.
    ttlMs: mcpHandoffRuntime.ttlMs(),
    endpointPath: '/mcp/private',
    walletBound: Boolean(identity),
  });
});

mcpHandoffRouter.post('/', (req: Request, res: Response) => {
  const flags = mcpHandoffRuntime.flags(process.env);
  if (!flags.routeIntelligenceV1 || !flags.b20ControlV1 || !flags.mcpPrivateV1) {
    res.status(404).json({ error: 'mcp_private_disabled', code: 'mcp_private_disabled' });
    return;
  }
  const secret = sessionSecretV1();
  if (!secret) {
    // Refused rather than defaulted. A signing key with a fallback value is a
    // signing key an attacker also has.
    res.status(503).json({ error: 'mcp_handoff_unavailable', code: 'mcp_handoff_unavailable' });
    return;
  }
  const identity = signedInWalletV1(req);
  if (!identity) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return;
  }

  const issued = mcpHandoffRuntime.issue({
    tenantId: identity.tenantId,
    walletAddress: identity.walletAddress,
    secret,
    now: mcpHandoffRuntime.now(),
    ttlMs: mcpHandoffRuntime.ttlMs(),
  });

  // §10 — the audit record. The token id, never the token: a log line that
  // carried the credential would hand it to every system that reads logs.
  logger.info('MCP handoff token issued', {
    tokenId: issued.tokenId,
    tenantId: identity.tenantId,
    expiresAt: issued.expiresAt,
  });

  res.json({
    token: issued.token,
    tokenId: issued.tokenId,
    expiresAt: issued.expiresAt,
    expiresInMs: issued.expiresInMs,
    walletAddress: identity.walletAddress,
    chainId: 8453,
    endpointPath: '/mcp/private',
    executionAvailable: flags.mcpPrivateExecutionV1,
    // Said plainly, because it is the one property of this credential a user
    // cannot infer from having it: nothing can take it back early.
    notice:
      'This token is bound to your wallet and expires on its own. It cannot be revoked before then, so treat it like a password and issue a new one rather than sharing this. It can never sign or send a transaction — every transaction still has to be approved in your Base Account.',
  });
});
