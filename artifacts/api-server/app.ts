import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import session from 'express-session';
import requestContext from 'express-request-context';
import crypto from 'node:crypto';
import { InMemoryRateLimiter } from '@mioagent/utils';
import { rateLimit } from './middleware/rate-limit';

export const app = express();
app.set('trust proxy', 1);

function configuredSessionSecret(): string {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === 'production') throw new Error('SESSION_SECRET is required in production');
  return 'dev_secret_key';
}

// Global rate limiter instance
const globalLimiter = new InMemoryRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per window
});

// Apply rate limiting early
app.use(rateLimit(globalLimiter));

// Security middleware
app.use(helmet({
  // Base Account and Base MCP OAuth use a user-opened popup. Helmet's default
  // `same-origin` policy severs window.opener after the cross-origin hop,
  // causing keys.coinbase.com to reject the flow. This policy retains opener
  // for the popup without relaxing frame, content or transport protections.
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
}));
const corsOrigins = process.env.CORS_ORIGIN
  || (process.env.NODE_ENV === 'test' ? 'https://miorail.xyz' : '');
const allowedCorsOrigins = corsOrigins
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0 && origin !== '*');
app.use(
  cors({
    // Session cookies and wildcard origins are mutually incompatible in
    // browsers. Same-origin deployments need no CORS headers; split frontend
    // deployments must opt in with an exact, comma-separated origin allowlist.
    origin: allowedCorsOrigins.length === 0
      ? false
      : (origin, callback) => callback(null, !origin || allowedCorsOrigins.includes(origin)),
    credentials: allowedCorsOrigins.length > 0,
    exposedHeaders: ['payment-response', 'x-payment-response', 'PAYMENT-REQUIRED'],
  })
);

// Body parser
app.use(express.json());

// Session middleware
app.use(
  session({
    secret: configuredSessionSecret(),
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24, // 1 day
    },
  })
);

// Request context middleware
app.use(requestContext());

import { observability } from './middleware/observability.js';

// Basic trace ID middleware to leverage requestContext
app.use((req: Request, res: Response, _next: NextFunction) => {
  const traceId = crypto.randomUUID();
  (req as Request & { context?: Record<string, unknown> }).context = (req as Request & { context?: Record<string, unknown> }).context || {};
  (req as Request & { context?: Record<string, unknown> }).context.traceId = traceId;
  res.setHeader('X-Trace-Id', traceId);
  _next();
});

// Observability and metrics middleware
app.use(observability);

import { routes } from './routes';

// API Routes
app.use('/api', routes);

// Health route
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not Found' });
});

import { logger } from '@mioagent/utils';
// Global error handler
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled API Error', {
    error: err.message,
    stack: err.stack,
    traceId: (req as unknown as { context?: { traceId?: string } }).context?.traceId
  });
  res.status(500).json({ error: 'Internal Server Error' });
});
