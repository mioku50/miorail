import { Router, type Request, type Response } from 'express';
import { InMemoryRateLimiter } from '@mioagent/utils';

import {
  miorailCheckAddressIdentityV1,
  identityCheckRuntime,
} from './mcp/identityTools.js';

// ---------------------------------------------------------------------------
// The identity check, over plain HTTP, with no session.
//
// The same reading the MCP tool returns, for the readers who have no assistant
// in front of them: somebody with an address in a wallet and a browser. It is
// mounted before the tenant middleware for the reason the public proof is —
// the people most likely to ask "is this the real one" are exactly the people
// who do not have an account here, and a login would make it unreachable by
// the only readers it exists for.
//
// It takes ANY address, unlike every other reviewed read, because two indexed
// lookups over stored rows is all it costs. Nothing here reaches the chain, a
// provider, or an endpoint a caller could aim.
// ---------------------------------------------------------------------------

export const publicIdentityRouter = Router();

/**
 * Its own limit, tighter than the global one and keyed by IP.
 *
 * Two database reads is cheap per call and not free in a loop, and this path
 * is the one an unauthenticated scraper finds first. Sixty a minute is more
 * than any person checking a token they hold, and far less than a crawl.
 */
const identityLimiter = new InMemoryRateLimiter({ windowMs: 60_000, max: 60 });

export const publicIdentityRuntime = {
  check: miorailCheckAddressIdentityV1,
  deps: identityCheckRuntime,
};

publicIdentityRouter.get('/identity/:tokenAddress', async (req: Request, res: Response) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const allowed = await identityLimiter.consume(`public-identity:${ip}`);
  res.setHeader('X-RateLimit-Limit', allowed.limit);
  res.setHeader('X-RateLimit-Remaining', allowed.remaining);
  if (!allowed.success) {
    res.status(429).json({ error: 'rate_limited', code: 'rate_limited' });
    return;
  }
  const tokenAddress = String(req.params.tokenAddress ?? '');
  if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) {
    // A ticker is refused rather than resolved. Different issuers publish
    // different contracts for the same company, and choosing between them on
    // a symbol is the exact mistake this endpoint exists to answer.
    res.status(400).json({
      error: 'exact_address_required',
      code: 'exact_address_required',
      detail:
        'This check takes one exact Base contract address. A ticker cannot select a contract: different issuers publish different contracts for the same company, and the address is the identity.',
    });
    return;
  }
  try {
    const reading = await publicIdentityRuntime.check({ chainId: 8453, tokenAddress });
    // Short, and shared. A standing changes when a source list or a scan
    // moves, which is hours apart — but never long enough that a withdrawn
    // accusation stays on somebody's screen.
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=60');
    res.json(reading);
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    res.status(503).json({
      error: typeof code === 'string' ? code : 'identity_check_unavailable',
      code: typeof code === 'string' ? code : 'identity_check_unavailable',
      detail:
        'Miorail could not read its own stored corpus for this address, so it has no answer. That is an outage here and says nothing about the token.',
    });
  }
});
