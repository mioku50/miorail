import { Request, Response, NextFunction } from 'express';
import { InMemoryRateLimiter, type RateLimitResult } from '@mioagent/utils';

/** Case and a trailing slash share an Express route. Decoding also groups
 * encoded spellings conservatively, including paths Express would reject. */
export function rateLimitPathV1(path: string): string {
  let decoded = path;
  try { decoded = decodeURIComponent(path); } catch { /* Count malformed escapes as written. */ }
  return decoded.toLowerCase().replace(/\/+$/, '') || '/';
}

function setRateLimitHeaders(res: Response, result: RateLimitResult) {
  res.setHeader('X-RateLimit-Limit', result.limit);
  res.setHeader('X-RateLimit-Remaining', result.remaining);
  res.setHeader('X-RateLimit-Reset', result.resetTime);
}

export function rateLimit(limiter: InMemoryRateLimiter, addressLimiter?: InMemoryRateLimiter) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      // Reject an exhausted address before allocating another path counter.
      const overall = addressLimiter ? await addressLimiter.consume(ip) : null;
      if (overall && !overall.success) {
        setRateLimitHeaders(res, overall);
        res.status(429).json({ error: 'Too Many Requests' });
        return;
      }
      const key = `${ip}:${rateLimitPathV1(req.path)}`;
      const result = await limiter.consume(key);
      setRateLimitHeaders(res, overall && overall.remaining < result.remaining ? overall : result);

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
