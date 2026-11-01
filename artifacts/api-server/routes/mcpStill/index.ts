import { Router, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InMemoryRateLimiter } from '@mioagent/utils';

import { createStillMcpServerV1 } from './server.js';

// ---------------------------------------------------------------------------
// The Still MCP endpoint, /mcp/still. Stateless like /mcp: a fresh server and
// transport per request, torn down when the response closes, so an
// unauthenticated caller cannot allocate a session.
//
// Every call can read the chain, so the limit is the public Still check's:
// thirty a minute per client is a person or an assistant checking wallets,
// not a crawler.
// ---------------------------------------------------------------------------

export const stillMcpRouter = Router();

export const stillMcpRuntimeV1 = {
  limiter: new InMemoryRateLimiter({ windowMs: 60_000, max: 30 }),
};

async function limited(req: Request, res: Response): Promise<boolean> {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const result = await stillMcpRuntimeV1.limiter.consume(`mcp-still:${ip}`);
  res.setHeader('X-RateLimit-Limit', result.limit);
  res.setHeader('X-RateLimit-Remaining', result.remaining);
  res.setHeader('X-RateLimit-Reset', result.resetTime);
  if (!result.success) {
    res.status(429).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Too many requests. Still rate-limits its MCP endpoint per client.' },
      id: null,
    });
    return true;
  }
  return false;
}

stillMcpRouter.post('/', async (req: Request, res: Response) => {
  if (await limited(req, res)) return;
  const server = createStillMcpServerV1();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch {
    // Never the cause: it may name a provider or carry a URL.
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Still could not answer that request.' }, id: null });
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

stillMcpRouter.get('/', methodNotAllowed);
stillMcpRouter.delete('/', methodNotAllowed);
