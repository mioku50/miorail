import { Router, type Request, type Response } from 'express';
import type { PublicMetricsSnapshotV1 } from '@mioagent/route-domain';

import { readPublicMetricsSnapshotV1 } from '../lib/publicMetrics.js';

export const publicMetricsRouter = Router();

export const publicMetricsRuntime = {
  read: readPublicMetricsSnapshotV1,
  now: () => new Date(),
};

let cached: { value: PublicMetricsSnapshotV1; expiresAt: number } | null = null;

publicMetricsRouter.get('/metrics', async (_req: Request, res: Response) => {
  try {
    const now = publicMetricsRuntime.now();
    if (!cached || cached.expiresAt <= now.getTime()) {
      cached = {
        value: await publicMetricsRuntime.read(now),
        expiresAt: now.getTime() + 60_000,
      };
    }
    res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=30');
    res.json({ snapshot: cached.value });
  } catch {
    res.status(503).json({ error: 'public_metrics_unavailable', code: 'public_metrics_unavailable' });
  }
});

export function clearPublicMetricsCacheForTestsV1(): void {
  cached = null;
}
