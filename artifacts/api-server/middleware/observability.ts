import { Request, Response, NextFunction } from 'express';
import { logger } from '@mioagent/utils';

export const observability = (req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  const traceId = (req as unknown as { context?: { traceId?: string } }).context?.traceId;

  logger.info('Request started', {
    traceId,
    method: req.method,
    url: req.url,
  });

  res.on('finish', () => {
    const durationMs = Date.now() - start;
    logger.info('Request finished', {
      traceId,
      method: req.method,
      url: req.url,
      status: res.statusCode,
      durationMs,
    });
  });

  next();
};
