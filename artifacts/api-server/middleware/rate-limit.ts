import { Request, Response, NextFunction } from 'express';
import { InMemoryRateLimiter } from '@mioagent/utils';

export function rateLimit(limiter: InMemoryRateLimiter) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      const key = `${ip}:${req.path}`;

      const result = await limiter.consume(key);

      res.setHeader('X-RateLimit-Limit', result.limit);
      res.setHeader('X-RateLimit-Remaining', result.remaining);
      res.setHeader('X-RateLimit-Reset', result.resetTime);

      if (!result.success) {
        res.status(429).json({ error: 'Too Many Requests' });
        return;
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}
