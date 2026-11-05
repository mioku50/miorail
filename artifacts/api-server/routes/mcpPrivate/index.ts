import { Router, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InMemoryRateLimiter, logger } from '@mioagent/utils';
import { createMiorailPrivateMcpServerV1 } from './server.js';
import { STILL_CARD_ADDRESS_V1, drawsStillCardV1 } from './stillCard.js';
import { STILL_CARD_LENDING_TOOL_V1 } from './stillCardLending.js';
import { MCP_PRIVATE_AUTH_COPY_V1, resolvePrivateIdentityV1 } from './session.js';
import { mcpOAuthResourceUrlV1 } from '../../lib/mcpOAuthProvider.js';
import { evidenceReadUsageV1 } from '../../lib/mcpEvidenceUsage.js';

// ---------------------------------------------------------------------------
// T72-B §1/§10 — the authenticated Streamable HTTP endpoint.
//
// A separate router from the public one, in a separate directory, mounted on a
// separate path. That separation is not cosmetic: `mcp/mcpServer.test.ts`
// asserts by listing its own directory that nothing in the PUBLIC surface can
// reach a signer, a plan or a wallet, and that assertion only stays meaningful
// while the executable surface lives somewhere else.
//
// Stateless, like the public endpoint: a fresh server per request, built around
// the identity that request proved. Nothing is carried between calls, so a
// token that expires mid-conversation stops working on the very next tool call
// rather than at the end of a session.
//
// §6 — nothing on this surface enters or exits a position by itself. Every tool
// is called explicitly, and the only executable thing any of them produces is
// unsigned calls that the user's own Base Account must approve. There is no
// timer, no queue and no autonomous path from a measurement to a transaction.
//
// §9 — no x402 here, deliberately. Recurring low-cost paid evidence stays on
// T71 Spend Permissions, where the user authorises a budget once. Per-request
// approvals for background Discover or Guard checks would mean an assistant
// deciding when to spend, which is the opposite arrangement.
// ---------------------------------------------------------------------------

export const mcpPrivateRouter = Router();

/**
 * §10 — strict limits, tighter than the public surface's.
 *
 * Keyed by the caller's token id rather than by IP: an MCP client sits behind
 * whatever egress its host has, so IP is close to meaningless here, while the
 * token identifies exactly one wallet's session. Unauthenticated attempts fall
 * back to IP so a caller cannot buy attempts by omitting the header.
 */
const authedLimiter = new InMemoryRateLimiter({ windowMs: 60_000, max: 20 });
// What a host repeats before every turn (Claude.ai: discover, initialize,
// initialized, the lists, about ten requests in two seconds) does no work
// upstream. Counted apart, it no longer spends the allowance the assistant's own
// tool calls need: on 2026-11-02 a reconnect beside two polling cards turned a
// purchase into a 429 that the assistant reported as Bitrefill refusing it.
const protocolLimiter = new InMemoryRateLimiter({ windowMs: 60_000, max: 120 });
const unauthedLimiter = new InMemoryRateLimiter({ windowMs: 60_000, max: 10 });
const PROTOCOL_METHODS_V1 = new Set(['initialize', 'ping', 'server/discover', 'tools/list', 'resources/list', 'resources/templates/list', 'prompts/list']);

/** The JSON-RPC method and id, and a tool call's tool: a name of ours, never an argument. */
function requestNameV1(body: unknown): { method: string; tool?: string; id: string | number | null } {
  const row = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const method = typeof row.method === 'string' ? row.method : 'unknown';
  const name = row.params && typeof row.params === 'object' ? (row.params as Record<string, unknown>).name : undefined;
  const tool = method === 'tools/call' && typeof name === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(name) ? name : undefined;
  return { method, ...(tool ? { tool } : {}), id: typeof row.id === 'string' || typeof row.id === 'number' ? row.id : null };
}

/**
 * MCP Apps: the grants whose client said, when it connected, that it draws
 * ui:// apps, and so is listed the card's own tool, which hands a ready
 * review's calls to the card. Every client's Still tools name the card itself
 * (server.ts), whatever is remembered here. This endpoint keeps no session,
 * and a client sends its capabilities once, with initialize, so they are
 * remembered per durable grant. A grant nobody remembers, after a restart for
 * one, is not listed that tool until its client connects again, or draws the
 * card: reading the card, or calling the card's own tool, is what only a host
 * that draws it does. On 2026-11-04 Claude did just that after a deploy, from
 * the tools it had listed before, without connecting again. The card is an
 * addition, never the only way through.
 */
export const mcpPrivateAppsRuntimeV1 = {
  grants: new Map<string, number>(),
  forMs: 30 * 24 * 60 * 60_000,
  now: () => Date.now(),
};

function drawsAppsV1(identity: { tokenId: string; tenantId: string }, body: unknown): boolean {
  const { grants, forMs, now } = mcpPrivateAppsRuntimeV1;
  // A browser session's token id is the same word for every wallet; the grant and its wallet together are one client.
  const tokenId = `${identity.tokenId}|${identity.tenantId}`;
  const request = body as { method?: unknown; params?: { capabilities?: unknown; uri?: unknown; name?: unknown } } | null;
  const drawsTheCard = (request?.method === 'resources/read' && typeof request.params?.uri === 'string' && STILL_CARD_ADDRESS_V1.test(request.params.uri))
    || (request?.method === 'tools/call' && request.params?.name === STILL_CARD_LENDING_TOOL_V1);
  if (request?.method === 'initialize' || drawsTheCard) {
    grants.delete(tokenId);
    if (drawsTheCard || drawsStillCardV1(request?.params?.capabilities)) grants.set(tokenId, now() + forMs);
    // A handful of assistants per wallet: the bound is headroom, oldest first.
    while (grants.size > 10_000) grants.delete(grants.keys().next().value!);
  }
  const until = grants.get(tokenId);
  return until !== undefined && until > now();
}

function jsonRpcError(res: Response, status: number, message: string, id: string | number | null = null): void {
  res.status(status).json({
    jsonrpc: '2.0',
    error: { code: status === 429 ? -32000 : -32001, message },
    id,
  });
}

mcpPrivateRouter.post('/', async (req: Request, res: Response) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const auth = await resolvePrivateIdentityV1(req);

  if (!auth.ok) {
    // Rate-limited on the UNAUTHENTICATED bucket, so a caller cannot probe
    // tokens at the authenticated allowance.
    const probe = await unauthedLimiter.consume(`mcp-private-anon:${ip}`);
    if (!probe.success) {
      jsonRpcError(res, 429, 'Too many requests.');
      return;
    }
    // 401 with a WWW-Authenticate header: an MCP client can then tell its user
    // that a credential is needed rather than reporting a broken server.
    res.setHeader(
      'WWW-Authenticate',
      `Bearer realm="miorail", resource_metadata="${new URL(`/.well-known/oauth-protected-resource${mcpOAuthResourceUrlV1().pathname}`, mcpOAuthResourceUrlV1()).href}"`,
    );
    jsonRpcError(res, auth.reason === 'mcp_private_disabled' ? 404 : 401, MCP_PRIVATE_AUTH_COPY_V1[auth.reason]);
    return;
  }

  const identity = auth.identity;
  const request = requestNameV1(req.body);
  const protocol = PROTOCOL_METHODS_V1.has(request.method) || request.method.startsWith('notifications/');
  const limit = protocol
    ? await protocolLimiter.consume(`mcp-private-protocol:${identity.tokenId}:${identity.tenantId}`)
    : await authedLimiter.consume(`mcp-private:${identity.tokenId}:${identity.tenantId}`);
  res.setHeader('X-RateLimit-Limit', limit.limit);
  res.setHeader('X-RateLimit-Remaining', limit.remaining);
  res.setHeader('X-RateLimit-Reset', limit.resetTime);
  if (!limit.success) {
    const wait = Math.max(1, Math.ceil((limit.resetTime - Date.now()) / 1000));
    res.setHeader('Retry-After', String(wait));
    logger.warn('MCP private request rate-limited', { tokenId: identity.tokenId, tenantId: identity.tenantId, method: request.method, ...(request.tool ? { tool: request.tool } : {}) });
    const said = `Miorail did not run this: the connection made more than ${limit.limit} ${protocol ? 'requests' : 'calls'} in a minute. `
      + `This is Miorail's own limit, not Bitrefill's, a lending protocol's or the chain's, and nothing was done. Try again in ${wait} seconds.`;
    // A tool call hears it as the tool's own result, which the model reads, so
    // it is not taken for the merchant's or the chain's answer.
    if (request.method === 'tools/call' && request.id !== null) {
      res.status(200).json({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: said }], isError: true } });
    } else jsonRpcError(res, 429, said, request.id);
    return;
  }

  // §10 — the audit record. Token id and tenant, never the token itself and
  // never the request body: a tool call on this surface can carry a plan id,
  // and the body may carry a batch id.
  const apps = drawsAppsV1(identity, req.body);
  logger.info('MCP private request', {
    tokenId: identity.tokenId,
    tenantId: identity.tenantId,
    source: identity.source,
    method: request.method,
    // The tool's name is one of ours; its arguments never are logged.
    ...(request.tool ? { tool: request.tool } : {}),
    apps,
  });

  const server = createMiorailPrivateMcpServerV1(identity, { onEvidenceRead: evidenceReadUsageV1({
    surface: 'connected', actorKey: identity.tenantId, userAgent: req.get('user-agent') ?? '',
  }) }, { apps });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch {
    // Never the cause. A storage error carries a connection string, and this
    // response may be pasted into a chat transcript.
    if (!res.headersSent) {
      jsonRpcError(res, 500, 'Miorail could not answer that request.');
    }
  }
});

function methodNotAllowed(_req: Request, res: Response): void {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'This MCP endpoint is stateless: use POST. There is no stream to resume.' },
    id: null,
  });
}

mcpPrivateRouter.get('/', methodNotAllowed);
mcpPrivateRouter.delete('/', methodNotAllowed);
