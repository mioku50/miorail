import type { Request, Response, NextFunction } from 'express';
import { ChatMessageRequestSchema } from '@mioagent/api-zod';
import { InMemoryRateLimiter } from '@mioagent/utils';
import { tenantWalletAddress } from './tenantAuth.js';

export const chatLimitsRuntimeV1 = {
  limiter: new InMemoryRateLimiter({ windowMs: 60_000, max: 12 }),
};

export async function chatLimitsV1(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!ChatMessageRequestSchema.safeParse(req.body).success) {
    res.status(400).json({ error: 'invalid_chat_message', code: 'invalid_chat_message' });
    return;
  }
  try {
    // The authenticated tenant supplies this address; body/IP/session changes
    // cannot buy a fresh window for the same production wallet.
    const wallet = tenantWalletAddress(req).toLowerCase();
    const result = await chatLimitsRuntimeV1.limiter.consume(wallet);
    if (!result.success) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil((result.resetTime - Date.now()) / 1000)));
      res.status(429).json({ error: 'chat_rate_limited', code: 'chat_rate_limited' });
      return;
    }
    next();
  } catch (error) { next(error); }
}
