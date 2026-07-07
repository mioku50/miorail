import { Request, Response, NextFunction } from 'express';
import { logger } from '@mioagent/utils';

const SENSITIVE_QUERY_KEYS = new Set([
  'access_token',
  'client_secret',
  'code',
  'code_verifier',
  'id_token',
  'refresh_token',
  'state',
]);

export function sanitizeRequestUrlForLogs(rawUrl: string): string {
  try {
    const url = new URL(rawUrl, 'http://local');
    const path = url.pathname;
    const shouldRedact =
      path.includes('/mcp/base/callback') ||
      (path.endsWith('/callback') && Array.from(url.searchParams.keys()).some((key) => SENSITIVE_QUERY_KEYS.has(key)));
    if (!shouldRedact) return rawUrl;

    for (const key of SENSITIVE_QUERY_KEYS) {
      if (url.searchParams.has(key)) url.searchParams.set(key, '[redacted]');
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return rawUrl;
  }
}

export const observability = (req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  const traceId = (req as unknown as { context?: { traceId?: string } }).context?.traceId;
  const urlForLogs = sanitizeRequestUrlForLogs(req.originalUrl || req.url);

  logger.info('Request started', {
    traceId,
    method: req.method,
    url: urlForLogs,
  });

  res.on('finish', () => {
    const durationMs = Date.now() - start;
    logger.info('Request finished', {
      traceId,
      method: req.method,
      url: urlForLogs,
      status: res.statusCode,
      durationMs,
    });
  });

  next();
};
