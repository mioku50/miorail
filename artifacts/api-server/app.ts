import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import session from 'express-session';
import requestContext from 'express-request-context';
import crypto from 'node:crypto';
import { InMemoryRateLimiter } from '@mioagent/utils';
import { rateLimit } from './middleware/rate-limit';

export const app = express();

// Global rate limiter instance
const globalLimiter = new InMemoryRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per window
});

// Apply rate limiting early
app.use(rateLimit(globalLimiter));

// Security middleware
app.use(helmet());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true,
  })
);

// Body parser
app.use(express.json());

// Session middleware
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24, // 1 day
    },
  })
);

// Request context middleware
app.use(requestContext());

// Basic trace ID middleware to leverage requestContext
app.use((req: Request, res: Response, _next: NextFunction) => {
  const traceId = crypto.randomUUID();
  (req as any).context = (req as any).context || {};
  (req as any).context.traceId = traceId;
  res.setHeader('X-Trace-Id', traceId);
  next();
});

// Health route
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: 'Not Found' });
});

// Global error handler
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Internal Server Error' });
});
