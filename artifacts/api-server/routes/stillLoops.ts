import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { logger } from '@mioagent/utils';

import { sessionWalletV1 } from '../lib/sessionWallet.js';
import {
  enterStillLoopDrawV1,
  settleStillLoopDrawsV1,
  stillLoopDrawBeforeEntryV1,
  stillLoopDrawListV1,
  stillLoopDrawMineV1,
  stillLoopDrawRuntimeV1,
  stillLoopDrawsPublicV1,
  type StillLoopDeliveryWordV1,
  type StillLoopDrawEnterOutcomeV1,
  type StillLoopDrawLoansV1,
  type StillLoopDrawPublicV1,
} from '../lib/stillLoopDraws.js';
import { COINBASE_VERIFIED_V1 } from '../lib/coinbaseVerified.js';
import { stillEntryGateV1 } from '../lib/stillRegion.js';
import { stillLoopDeliveryOfV1, stillLoopPublicV1, stillLoopsRuntimeV1, stillLoopWeekStartV1, stillLoopWireV1, type StillLoopPublicV1 } from '../lib/stillLoops.js';
import { stillPaidLoansSinceV1 } from './rwaLending.js';
import { stillSpendRuntimeV1 } from './stillSpend.js';

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
// GET /api/still/loops/mine: the session's own Loops, so its owner can put one
// on the wall from /loops, wherever it was made.
//
// The draws (lib/stillLoopDraws.ts), while STILL_LOOP_DRAW_V1=on as well:
// GET /api/public/still/loops/draws/:drawId is a fixed list as anybody can
// check it; GET /api/still/loops/draw is the session's own entries and the
// Loop it may enter with; POST /api/still/loops/draw/enter is the entry, with
// that Loop or free.
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
  /** Null while the draws are off. */
  draws: { current: StillLoopDrawPublicV1 | null; past: StillLoopDrawPublicV1[] } | null;
}

async function readPublicV1(now: Date): Promise<StillLoopsPublicAnswerV1> {
  const repository = stillLoopsRuntimeV1.repository();
  const weekStart = stillLoopWeekStartV1(now);
  const [counts, wall, draws] = await Promise.all([
    repository.counts({ weekSince: weekStart }), repository.wall({ limit: WALL_SIZE_V1 }),
    stillLoopDrawRuntimeV1.enabled() ? stillLoopDrawsPublicV1(now) : Promise.resolve(null),
  ]);
  return { outcome: 'loops', weekStartsAt: weekStart.toISOString(), counts, wall: wall.map(stillLoopPublicV1), draws };
}

const errorNameV1 = (error: unknown) => error instanceof Error ? error.name : typeof error;

/** A list or a winner that is due is settled on any read, besides the tick; never in the read's way. */
function settleSoonV1(): void {
  if (!stillLoopDrawRuntimeV1.enabled()) return;
  settleStillLoopDrawsV1().catch((error: unknown) => logger.warn('Still Loop draw not settled', { errorName: errorNameV1(error) }));
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
  settleSoonV1();
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

/** The session wallet's own Loops, for its owner's page: each with its number, its card and whether it is on the wall,
 * so a Loop made in an assistant's chat can go on the wall from /loops too. Never anybody else's. */
stillLoopsRouter.get('/mine', async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'private, no-store');
  const wallet = sessionWalletV1(req, res);
  if (!wallet) return;
  if (!stillLoopsRuntimeV1.enabled()) {
    res.status(404).json({ error: 'loops_off' });
    return;
  }
  try {
    const loops = await stillLoopsRuntimeV1.repository().byWallet({ walletAddress: wallet, limit: 20 });
    res.json({ outcome: 'mine', loops: loops.filter((loop) => !loop.team).map((loop) => ({
      ...stillLoopWireV1(loop), executionId: loop.executionId, productName: loop.productName, packageLabel: loop.packageLabel, day: loop.confirmedAt.slice(0, 10),
    })) });
  } catch (error) {
    logger.warn('Still Loops of a wallet not read', { errorName: errorNameV1(error) });
    res.status(503).json({ error: 'unavailable' });
  }
});

const DRAW_ID_V1 = /^\d{4}-\d{2}-\d{2}$/;

publicStillLoopsRouter.get('/loops/draws/:drawId', async (req: Request, res: Response) => {
  const drawId = String(req.params.drawId ?? '');
  if (!stillLoopDrawRuntimeV1.enabled()) {
    res.status(404).json({ outcome: 'draws_off' });
    return;
  }
  if (!DRAW_ID_V1.test(drawId)) {
    res.status(400).json({ outcome: 'draw_id_invalid' });
    return;
  }
  settleSoonV1();
  try {
    const list = await stillLoopDrawListV1(drawId);
    if (!list) {
      res.status(404).json({ outcome: 'draw_not_fixed', detail: 'This draw’s list is fixed 30 seconds after it closes.' });
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=30');
    res.json({ outcome: 'draw', ...list });
  } catch (error) {
    logger.warn('Still Loop draw list not read', { errorName: errorNameV1(error) });
    res.status(503).json({ outcome: 'unavailable' });
  }
});

stillLoopsRouter.get('/draw', async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'private, no-store');
  const wallet = sessionWalletV1(req, res);
  if (!wallet) return;
  if (!stillLoopDrawRuntimeV1.enabled()) {
    res.status(404).json({ error: 'draws_off' });
    return;
  }
  try {
    res.json({ outcome: 'mine', ...(await stillLoopDrawMineV1(wallet, stillLoopDrawRuntimeV1.now(), stillLoopDrawLoansRuntimeV1.of(wallet))) });
  } catch (error) {
    logger.warn('Still Loop draw entries not read', { errorName: errorNameV1(error) });
    res.status(503).json({ error: 'unavailable' });
  }
});

/** What an entry reads of the session wallet's loans: its paid loans, read again from Base as their pages read them,
 * and Bitrefill's word on a card while Spend still holds the open order. */
export function stillLoopDrawLoansV1(wallet: string): StillLoopDrawLoansV1 {
  const owner = { tenantId: `eip155:8453:${wallet}`, walletAddress: wallet };
  return {
    paidSince: (since) => stillPaidLoansSinceV1(owner, since),
    delivery: async (record): Promise<StillLoopDeliveryWordV1> => {
      const payment = record.run.facts.payment;
      const order = payment ? stillSpendRuntimeV1.orders.get(owner, payment.orderId) : null;
      if (!order) return 'forgotten';
      const read = await stillSpendRuntimeV1.invoiceReads.display({ wallet, order, checkout: stillSpendRuntimeV1.checkout() });
      return stillLoopDeliveryOfV1(read.status?.status) ?? 'pending';
    },
  };
}

/** A seam, so a test hands in the loans it means. */
export const stillLoopDrawLoansRuntimeV1 = { of: (wallet: string): StillLoopDrawLoansV1 => stillLoopDrawLoansV1(wallet) };

const EnterBodyV1 = z.object({ rules: z.literal(true) }).strict();
const NOT_VERIFIED_DETAIL_V1 = 'Without a Loop made while this draw is open, an entry needs one of two on this wallet: a swap of at least 10 USDC '
  + 'made through Still at any time (Swap AI, or Buy and Sell on Stocks), or Coinbase’s Verified Account attestation, which Coinbase gives at '
  + `${COINBASE_VERIFIED_V1.url}. Then enter again here.`;

stillLoopsRouter.post('/draw/enter', async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'private, no-store');
  const wallet = sessionWalletV1(req, res);
  if (!wallet) return;
  if (!EnterBodyV1.safeParse(req.body ?? {}).success) {
    res.status(400).json({ error: 'draw_request_invalid', detail: 'Accept the rules to enter.' });
    return;
  }
  if (!stillLoopDrawRuntimeV1.enabled()) {
    res.status(404).json({ error: 'draws_off' });
    return;
  }
  try {
    const before = await stillLoopDrawBeforeEntryV1(wallet, stillLoopDrawRuntimeV1.now());
    if (before.outcome === 'ask') {
      // Not offered where Still is not: the same check, and the same confirmation, as a new loan, whichever way in.
      const gate = await stillEntryGateV1(req, { kind: 'draw_entry', confirmation: true });
      if (!gate.ok) {
        res.status(403).json({ error: gate.refusal, detail: gate.detail });
        return;
      }
      const entered = await enterStillLoopDrawV1(wallet, before.draw, stillLoopDrawLoansRuntimeV1.of(wallet));
      sendEnteredV1(res, entered);
      return;
    }
    sendEnteredV1(res, before);
  } catch (error) {
    logger.warn('Still Loop draw entry not written', { errorName: errorNameV1(error) });
    res.status(503).json({ error: 'unavailable', detail: 'The entry could not be checked or written just now. Nothing was entered; try again in a minute.' });
  }
});

function sendEnteredV1(res: Response, outcome: StillLoopDrawEnterOutcomeV1): void {
  if (outcome.outcome === 'entered' || outcome.outcome === 'already') {
    forgetStillLoopsPublicV1();
    res.json({ outcome: outcome.outcome, drawId: outcome.drawId, closesAt: outcome.closesAt, entry: outcome.entry });
  } else if (outcome.outcome === 'not_open') {
    res.status(409).json({ error: 'draw_not_open', next: outcome.next, detail: outcome.next ? `The next draw opens ${outcome.next.opensAt}.` : 'No draw is open.' });
  } else if (outcome.outcome === 'team') {
    res.status(409).json({ error: 'draw_team', detail: 'The Still team does not enter its own draws.' });
  } else if (outcome.outcome === 'loop_pending') {
    res.status(409).json({ error: 'draw_loop_pending', loopNo: outcome.loopNo,
      detail: `Bitrefill has not delivered the card of Loop #${outcome.loopNo} yet. Enter with it once the card arrives, before the draw closes.` });
  } else {
    res.status(403).json({ error: 'not_verified', detail: NOT_VERIFIED_DETAIL_V1, url: COINBASE_VERIFIED_V1.url });
  }
}
