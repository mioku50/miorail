import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { logger } from '@mioagent/utils';

import { sessionWalletV1 } from '../lib/sessionWallet.js';
import { stillLoopPublicV1, stillLoopsRuntimeV1, stillLoopWeekStartV1, stillLoopWireV1, type StillLoopPublicV1 } from '../lib/stillLoops.js';

// ---------------------------------------------------------------------------
// Loops in public, and their owner's one choice about them.
//
// GET /api/public/still/loops: the counts and the latest Loops their owners put
// on the wall. No wallet, no transaction, no exact amount: the number, the
// brand, the product, the price to the dollar, the venue, who prepared it and
// the day. Kept 30 seconds.
//
// POST /api/still/loops/:executionId/wall: the session's own Loop goes on the
// wall, under the wallet's checked Basename only when the owner asks for it.
// ---------------------------------------------------------------------------

export const publicStillLoopsRouter = Router();
export const stillLoopsRouter = Router();

const WALL_SIZE_V1 = 50;
const CACHE_MS_V1 = 30_000;
let cachedV1: { at: number; body: Promise<StillLoopsPublicAnswerV1> } | null = null;

export interface StillLoopsPublicAnswerV1 {
  outcome: 'loops';
  weekStartsAt: string;
  counts: { total: number; week: number; byBrand: Record<string, number>; viaAssistant: number };
  wall: StillLoopPublicV1[];
}

async function readPublicV1(now: Date): Promise<StillLoopsPublicAnswerV1> {
  const repository = stillLoopsRuntimeV1.repository();
  const weekStart = stillLoopWeekStartV1(now);
  const [counts, wall] = await Promise.all([repository.counts({ weekSince: weekStart }), repository.wall({ limit: WALL_SIZE_V1 })]);
  return { outcome: 'loops', weekStartsAt: weekStart.toISOString(), counts, wall: wall.map(stillLoopPublicV1) };
}

/** Forget the kept answer: a test, or a Loop that just went on the wall. */
export function forgetStillLoopsPublicV1(): void {
  cachedV1 = null;
}

publicStillLoopsRouter.get('/loops', async (_req: Request, res: Response) => {
  if (!stillLoopsRuntimeV1.enabled()) {
    res.status(404).json({ outcome: 'loops_off' });
    return;
  }
  const now = stillLoopsRuntimeV1.now();
  if (!cachedV1 || now.getTime() - cachedV1.at > CACHE_MS_V1) {
    const body = readPublicV1(now);
    cachedV1 = { at: now.getTime(), body };
    body.catch(() => { if (cachedV1?.body === body) cachedV1 = null; });
  }
  try {
    const body = await cachedV1.body;
    res.setHeader('Cache-Control', 'public, max-age=30');
    res.json(body);
  } catch (error) {
    logger.warn('Still Loops not read', { errorName: error instanceof Error ? error.name : typeof error });
    res.status(503).json({ outcome: 'unavailable' });
  }
});

const UUID_V1 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WallBodyV1 = z.object({ showName: z.boolean() }).strict();
const LABEL_V1 = /^[a-z0-9-]{1,63}\.base\.eth$/;

stillLoopsRouter.post('/:executionId/wall', async (req: Request, res: Response) => {
  const wallet = sessionWalletV1(req, res);
  if (!wallet) return;
  const executionId = String(req.params.executionId ?? '').toLowerCase();
  const body = WallBodyV1.safeParse(req.body ?? {});
  if (!UUID_V1.test(executionId) || !body.success) {
    res.status(400).json({ error: 'loop_request_invalid' });
    return;
  }
  if (!stillLoopsRuntimeV1.enabled()) {
    res.status(404).json({ error: 'loops_off' });
    return;
  }
  try {
    // The owner's own name, read back and checked forward; a name it cannot show plainly is not shown.
    const name = body.data.showName ? await stillLoopsRuntimeV1.basename(wallet) : null;
    const label = name && LABEL_V1.test(name) ? name : null;
    const loop = await stillLoopsRuntimeV1.repository().putOnWall({ executionId, walletAddress: wallet, label, at: stillLoopsRuntimeV1.now() });
    if (!loop) {
      res.status(409).json({ error: 'loop_not_wallable', detail: 'Only your own Loop goes on the wall, once Bitrefill says the card arrived.' });
      return;
    }
    forgetStillLoopsPublicV1();
    res.json({ loop: stillLoopWireV1(loop), label: loop.wallLabel, nameShown: body.data.showName ? loop.wallLabel !== null : null });
  } catch (error) {
    logger.warn('Still Loop not put on the wall', { errorName: error instanceof Error ? error.name : typeof error });
    res.status(503).json({ error: 'unavailable' });
  }
});

