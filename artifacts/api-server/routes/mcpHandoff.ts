import { Router, type Request, type Response } from 'express';
import { InMemoryRateLimiter, logger } from '@mioagent/utils';
import { getMiorailProductMigrationFlags } from '../lib/productMigrationConfig.js';
import {
  MCP_HANDOFF_MAX_TTL_MS_V1,
  handoffTtlMsV1,
  issueHandoffTokenV1,
} from '../lib/mcpHandoffToken.js';
import { mcpAuditRuntime, recordAuditV1 } from './mcpPrivate/audit.js';
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
  audit: mcpAuditRuntime,
  record: recordAuditV1,
};

/**
 * §7 — issuance is bounded per tenant.
 *
 * Not per IP: minting requires a signed-in session, so the tenant is the real
 * identity and the IP is whatever their browser happens to be behind. Ten an
 * hour is generous for a human pasting a token into a client config and mean
 * for anything harvesting them.
 */
const issuanceLimiter = new InMemoryRateLimiter({ windowMs: 60 * 60 * 1000, max: 10 });

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

/**
 * T72-C §8 — the deployment verification summary, as data.
 *
 * Every line is a fact this server can actually check right now, not a copy of
 * the environment file: audit storage is `available` because the tables were
 * looked for, not because a variable says so. A summary that reported intent
 * rather than state is exactly the kind of thing an operator would trust and
 * then be wrong about.
 */
export async function mcpPrivateStatusV1(): Promise<Record<string, unknown>> {
  const flags = mcpHandoffRuntime.flags(process.env);
  // A storage error is reported as "not available" rather than propagated:
  // this endpoint exists to be readable precisely when things are broken.
  const auditAvailable = await mcpHandoffRuntime.audit.available().catch(() => false);
  const ttlMs = mcpHandoffRuntime.ttlMs();
  return {
    privateSurfaceEnabled: flags.mcpPrivateV1 && Boolean(sessionSecretV1()),
    executableHandoffEnabled: flags.mcpPrivateV1 && flags.mcpPrivateExecutionV1,
    tokenTtlMs: ttlMs,
    tokenTtlMinutes: Math.round(ttlMs / 60_000),
    tokenTtlCeilingMs: MCP_HANDOFF_MAX_TTL_MS_V1,
    auditStorageAvailable: auditAvailable,
    publicMcp: 'read_only' as const,
    liveSmokeEnabled: (process.env.MIORAIL_MCP_LIVE_SMOKE ?? '').trim().toLowerCase() === 'true',
    endpointPath: '/mcp/private',
  };
}

/** §8 — the same facts as the operator-facing block. One producer, so the
 * printed summary and the JSON cannot disagree. */
export function mcpPrivateStatusLinesV1(status: Record<string, unknown>): string[] {
  const yesNo = (value: unknown) => (value ? 'enabled' : 'disabled');
  return [
    `Private MCP surface: ${yesNo(status.privateSurfaceEnabled)}`,
    `Executable handoff: ${yesNo(status.executableHandoffEnabled)}`,
    `Token TTL: ${status.tokenTtlMinutes} minutes`,
    `Audit storage: ${status.auditStorageAvailable ? 'available' : 'unavailable'}`,
    `Public MCP: read-only`,
    `Live smoke: ${yesNo(status.liveSmokeEnabled)}`,
  ];
}

mcpHandoffRouter.get('/', async (req: Request, res: Response) => {
  const identity = signedInWalletV1(req);
  const status = await mcpPrivateStatusV1();
  res.json({
    ...status,
    // Kept for the surfaces that already read these names.
    available: status.privateSurfaceEnabled,
    executionAvailable: status.executableHandoffEnabled,
    // Stated so a surface can tell the user how long a token will last before
    // they paste it into a client config, rather than after it stops working.
    ttlMs: status.tokenTtlMs,
    walletBound: Boolean(identity),
    summary: mcpPrivateStatusLinesV1(status),
  });
});

mcpHandoffRouter.post('/', async (req: Request, res: Response) => {
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

  const allowance = await issuanceLimiter.consume(`mcp-handoff:${identity.tenantId}`);
  res.setHeader('X-RateLimit-Limit', allowance.limit);
  res.setHeader('X-RateLimit-Remaining', allowance.remaining);
  res.setHeader('X-RateLimit-Reset', allowance.resetTime);
  if (!allowance.success) {
    res.status(429).json({ error: 'mcp_handoff_rate_limited', code: 'mcp_handoff_rate_limited' });
    return;
  }

  const issued = mcpHandoffRuntime.issue({
    tenantId: identity.tenantId,
    walletAddress: identity.walletAddress,
    secret,
    now: mcpHandoffRuntime.now(),
    ttlMs: mcpHandoffRuntime.ttlMs(),
  });

  // T72-C §1 — the audit record, now a row rather than only a log line. The
  // token id, never the token: a row that carried the credential would hand it
  // to every system that can read the database.
  //
  // Best-effort. A user who cannot mint a token because an audit table is
  // missing is a user locked out of their own product, and nothing
  // irreversible happens at issuance — the token cannot sign, and every action
  // it later enables is itself audited, mandatorily.
  await mcpHandoffRuntime.record({
    tokenId: issued.tokenId,
    tenantId: identity.tenantId,
    walletAddress: identity.walletAddress,
    toolName: 'handoff_issue',
    outcome: 'token_issued',
  });
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
    // Said plainly, because these are the two properties a holder cannot infer
    // from having the token.
    notice:
      'This token is bound to your wallet and expires on its own. Treat it like a password: anyone holding it can read your plans and, while executable handoff is on, fetch the calls for one. It can never sign or send a transaction — every transaction still has to be approved in your Base Account. If you lose it, revoke it by its token id.',
    revokePath: '/api/mcp/handoff/revoke',
  });
});

/**
 * T72-C §3 — early revocation.
 *
 * Revoking takes the token ID, never the token. That is not a convenience: an
 * endpoint that accepted the credential would be an endpoint a user could be
 * tricked into pasting one into, and it would put the token in a request body,
 * a log and an error report on the way.
 *
 * Tenant-scoped by the key, so revoking a token id that belongs to somebody
 * else records a revocation against your own tenant and changes nothing for
 * theirs.
 */
mcpHandoffRouter.post('/revoke', async (req: Request, res: Response) => {
  const flags = mcpHandoffRuntime.flags(process.env);
  if (!flags.mcpPrivateV1) {
    res.status(404).json({ error: 'mcp_private_disabled', code: 'mcp_private_disabled' });
    return;
  }
  const identity = signedInWalletV1(req);
  if (!identity) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const tokenId = typeof body.tokenId === 'string' ? body.tokenId.trim() : '';
  // Checked FIRST, before the length bound, because it is the diagnosis a user
  // who pasted the wrong thing actually needs. A token is also too long, and
  // "too long" would send them looking for the wrong problem.
  if (tokenId.includes('.')) {
    res.status(400).json({
      error: 'invalid_token_id',
      code: 'invalid_token_id',
      detail: 'That looks like the token itself. Revoke by token id — Miorail never stores the token.',
    });
    return;
  }
  if (!tokenId || tokenId.length > 100 || tokenId === 'session') {
    res.status(400).json({ error: 'invalid_token_id', code: 'invalid_token_id' });
    return;
  }

  try {
    if (!(await mcpHandoffRuntime.audit.available())) {
      // Fails CLOSED, unlike the lookup on the read path: a revocation that
      // silently did not persist is worse than one that reports it could not.
      res.status(503).json({ error: 'mcp_revocation_unavailable', code: 'mcp_revocation_unavailable' });
      return;
    }
    const now = mcpHandoffRuntime.now();
    await mcpHandoffRuntime.audit.revocations().revoke({
      tokenId,
      tenantId: identity.tenantId,
      revokedAt: now.toISOString(),
      // The token's own expiry is not knowable from the id alone, so the
      // ceiling is recorded: a revocation must outlive any token it could
      // apply to, and pruning uses this.
      expiresAt: new Date(now.getTime() + MCP_HANDOFF_MAX_TTL_MS_V1).toISOString(),
    });
  } catch (error) {
    logger.warn('MCP handoff revocation failed', {
      name: error instanceof Error ? error.name : 'unknown',
    });
    res.status(503).json({ error: 'mcp_revocation_unavailable', code: 'mcp_revocation_unavailable' });
    return;
  }

  // Idempotent, and says so: revoking twice is not an error, and a user who
  // clicks twice should not be told something went wrong.
  res.json({
    revoked: true,
    tokenId,
    notice:
      'That token is refused from now on. Anything it already did is in your execution audit; revoking does not undo a transaction your wallet already approved.',
  });
});
