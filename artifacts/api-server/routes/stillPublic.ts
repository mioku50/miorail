import { Router, type Request, type Response } from 'express';
import type { MirrorOutcome } from '@mioagent/still-engine';
import { InMemoryRateLimiter, logger } from '@mioagent/utils';

import { stillMirrorRuntimeV1, stillTermsV1 } from '../lib/stillMirror.js';

// ---------------------------------------------------------------------------
// Still's public door: any Base wallet, by address or name, and how much it
// could borrow through Still without selling. It is the same check stills.lat
// has answered since 2026-10-25, now served by this API.
//
// It reads public chain state only, the way an explorer does, so it needs no
// session. What a public door adds is a cost nobody controls. Every read here
// is a live chain read, so the limit is per address: thirty a minute is a
// person checking wallets, not a crawler.
// ---------------------------------------------------------------------------

export const publicStillRouter = Router();

export const publicStillRuntimeV1 = {
  limiter: new InMemoryRateLimiter({ windowMs: 60_000, max: 30 }),
  service: () => stillMirrorRuntimeV1.service(),
  now: () => new Date(),
};

const STATUS_V1: Record<MirrorOutcome['outcome'], 200 | 400 | 404 | 503> = {
  report: 200,
  invalid_subject: 400,
  name_not_found: 404,
  // Both are our failure, never a fact about the wallet or the name.
  names_unavailable: 503,
  chain_unavailable: 503,
};

publicStillRouter.use(async (req: Request, res: Response, next) => {
  res.setHeader('Cache-Control', 'no-store');
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const allowed = await publicStillRuntimeV1.limiter.consume(`public-still:${ip}`);
  res.setHeader('X-RateLimit-Limit', allowed.limit);
  res.setHeader('X-RateLimit-Remaining', allowed.remaining);
  if (!allowed.success) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((allowed.resetTime - Date.now()) / 1000))));
    res.status(429).json({ outcome: 'rate_limited' });
    return;
  }
  next();
});

publicStillRouter.get('/mirror', async (req: Request, res: Response) => {
  const subject = typeof req.query.subject === 'string' ? req.query.subject : '';
  if (subject.length > 256) {
    res.status(400).json({ outcome: 'invalid_subject', input: '', reason: 'not_an_address_or_name' });
    return;
  }
  try {
    const outcome = await publicStillRuntimeV1.service().check(subject);
    res.status(STATUS_V1[outcome.outcome]).json(outcome);
  } catch (error) {
    logger.warn('Still mirror read failed', { errorName: error instanceof Error ? error.name : typeof error });
    res.status(500).json({ outcome: 'internal_error' });
  }
});

publicStillRouter.get('/terms', async (_req: Request, res: Response) => {
  try {
    // The calendar never rejects: an unread one comes back as `ok: false` and
    // every stock then counts at the earnings rate.
    const read = await publicStillRuntimeV1.service().earnings();
    res.json(stillTermsV1(read, publicStillRuntimeV1.now()));
  } catch (error) {
    logger.warn('Still terms read failed', { errorName: error instanceof Error ? error.name : typeof error });
    res.status(500).json({ outcome: 'internal_error' });
  }
});
