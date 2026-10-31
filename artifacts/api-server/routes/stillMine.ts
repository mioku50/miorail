import express, { Router, type Request, type Response } from 'express';
import { InMemoryRateLimiter, logger } from '@mioagent/utils';

import { sessionWalletV1 } from '../lib/sessionWallet.js';
import { answerStillAgentV3 } from '../lib/stillAgentServer.js';
import { STILL_OUTCOME_STATUS_V1, stillMirrorRuntimeV1 } from '../lib/stillMirror.js';
import { rememberStillReadingV1 } from '../lib/stillReadings.js';

// ---------------------------------------------------------------------------
// The signed-in wallet's own Mirror: its loans on Aave V4 and Morpho, read from
// Base at one block, and what Still could lend it on top.
//
// It is the one source for "my loan". The console's Aave card read the Aave
// API's position until 2026-10-26, while Still read the same position from the
// chain, so one loan could show two debts. Both now read this.
//
// The session proves the wallet. No address is taken from the request, so the
// answer is never about somebody else.
// ---------------------------------------------------------------------------

export const stillMineRuntimeV1 = {
  service: () => stillMirrorRuntimeV1.service(),
  // A question can cost two model calls and a chain read: a person asks a few
  // a minute, a script asks hundreds.
  askLimiter: new InMemoryRateLimiter({ windowMs: 60_000, max: 12 }),
};
export const stillMineRouter = Router();

stillMineRouter.get('/mine', async (req: Request, res: Response) => {
  res.set('Cache-Control', 'private, no-store');
  const wallet = sessionWalletV1(req, res);
  if (!wallet) return;
  if (Object.keys(req.query).length > 0) {
    res.status(400).json({ outcome: 'invalid_input' });
    return;
  }
  try {
    const outcome = await stillMineRuntimeV1.service().check(wallet);
    if (outcome.outcome === 'report' && outcome.report.subject.address.toLowerCase() !== wallet) {
      throw new Error('still_mine_wallet_mismatch');
    }
    // The room the person is shown now is the one a later "why did it change" compares with.
    if (outcome.outcome === 'report') void rememberStillReadingV1(wallet, outcome.report);
    res.status(STILL_OUTCOME_STATUS_V1[outcome.outcome]).json(outcome);
  } catch (error) {
    logger.warn('Still mirror read failed', { errorName: error instanceof Error ? error.name : typeof error });
    res.status(500).json({ outcome: 'internal_error' });
  }
});

// The Agent's questions about this wallet. The browser sends only the question:
// the figures come from this server's own reading of the session wallet (the
// same cached service as /mine), never from a report the page posts back, so
// an answer marked as calculated cannot rest on numbers the browser supplied.
//
// Asked with `Accept: application/x-ndjson`, the answer streams: one line per
// stage of the work as it happens, then the answer. nginx buffers responses by
// default, so the stream says it must not be.
stillMineRouter.post('/agent/ask', express.json({ limit: '8kb' }), async (req: Request, res: Response) => {
  res.set('Cache-Control', 'private, no-store');
  const wallet = sessionWalletV1(req, res);
  if (!wallet) return;

  const body = (req.body ?? {}) as { question?: unknown };
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question || question.length > 500) {
    res.status(400).json({ ok: false, outcome: 'invalid_input' });
    return;
  }
  const allowed = await stillMineRuntimeV1.askLimiter.consume(`still-agent:${wallet}`);
  if (!allowed.success) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((allowed.resetTime - Date.now()) / 1000))));
    res.status(429).json({ ok: false, outcome: 'rate_limited' });
    return;
  }

  const stream = String(req.headers.accept ?? '').includes('application/x-ndjson');
  const send = (line: Record<string, unknown>) => {
    if (stream && !res.writableEnded) res.write(`${JSON.stringify(line)}\n`);
  };
  if (stream) {
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
  }
  try {
    const service = stillMineRuntimeV1.service();
    const answer = await answerStillAgentV3({
      question,
      wallet,
      read: () => service.reading(wallet as `0x${string}`),
      onStage: (stage) => send({ type: 'stage', ...stage }),
    });
    if (stream) {
      send({ type: 'answer', answer });
      res.end();
    } else {
      res.status(200).json({ ok: true, answer });
    }
  } catch (error) {
    logger.warn('Still agent ask failed', { errorName: error instanceof Error ? error.name : typeof error });
    if (stream) {
      send({ type: 'error', outcome: 'internal_error' });
      res.end();
    } else {
      res.status(500).json({ ok: false, outcome: 'internal_error' });
    }
  }
});
