import { Router, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InMemoryRateLimiter } from '@mioagent/utils';
import { createMiorailMcpServerV1 } from './server.js';

// ---------------------------------------------------------------------------
// T72 §1/§6 — the Streamable HTTP endpoint.
//
// STATELESS: a fresh server and transport per request, torn down when the
// response closes. This surface is public and unauthenticated, so a session
// map would be an unbounded, attacker-controlled allocation keyed by a header
// anybody can set. Nothing here needs continuity between calls — every tool is
// a read of stored evidence.
//
// Mounted BEFORE the tenant middleware. An MCP client has no Miorail session,
// no wallet and no SIWE, and putting a read-only public feed behind a login
// would make it unreachable by the only clients it exists for.
// ---------------------------------------------------------------------------

export const mcpServerRouter = Router();

/**
 * §6 — a dedicated limit, tighter than the global one.
 *
 * Each call can reach Postgres, and an assistant in a loop is the normal case
 * rather than the abusive one. Keyed by IP alone (not by path) because all MCP
 * traffic arrives on this one route: keying by path would let a caller
 * multiply their allowance across methods.
 */
const mcpLimiter = new InMemoryRateLimiter({ windowMs: 60_000, max: 30 });

async function limited(req: Request, res: Response): Promise<boolean> {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const result = await mcpLimiter.consume(`mcp:${ip}`);
  res.setHeader('X-RateLimit-Limit', result.limit);
  res.setHeader('X-RateLimit-Remaining', result.remaining);
  res.setHeader('X-RateLimit-Reset', result.resetTime);
  if (!result.success) {
    res.status(429).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Too many requests. Miorail rate-limits its MCP endpoint per client.' },
      id: null,
    });
    return true;
  }
  return false;
}

mcpServerRouter.post('/', async (req: Request, res: Response) => {
  if (await limited(req, res)) return;

  const server = createMiorailMcpServerV1();
  const transport = new StreamableHTTPServerTransport({
    // Stateless: no session id is issued and none is validated.
    sessionIdGenerator: undefined,
  });

  // Torn down on close rather than on a timer: a transport that outlived its
  // response would hold a database-capable server object per abandoned request.
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
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Miorail could not answer that request.' },
        id: null,
      });
    }
  }
});

/**
 * GET and DELETE exist to be refused properly.
 *
 * In stateless mode there is no stream to resume and no session to end, and a
 * bare 404 would leave a client guessing whether the endpoint exists at all.
 */
function methodNotAllowed(_req: Request, res: Response): void {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'This MCP endpoint is stateless: use POST. There is no stream to resume.' },
    id: null,
  });
}

mcpServerRouter.get('/', methodNotAllowed);
mcpServerRouter.delete('/', methodNotAllowed);
