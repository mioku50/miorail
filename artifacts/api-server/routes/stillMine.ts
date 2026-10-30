import express, { Router, type Request, type Response } from 'express';
import { logger } from '@mioagent/utils';
import type { MirrorReport } from '@mioagent/still-engine/report';

import { sessionWalletV1 } from '../lib/sessionWallet.js';
import { answerStillAgentHybridV2 } from '../lib/stillAgentServer.js';
import { STILL_OUTCOME_STATUS_V1, stillMirrorRuntimeV1 } from '../lib/stillMirror.js';

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

export const stillMineRuntimeV1 = { service: () => stillMirrorRuntimeV1.service() };
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

  try {
    let report: MirrorReport | null = null;
    const outcome = await stillMineRuntimeV1.service().check(wallet);
    if (outcome.outcome === 'report') {
      if (outcome.report.subject.address.toLowerCase() !== wallet) {
        throw new Error('still_mine_wallet_mismatch');
      }
      report = outcome.report;
    }

    // The questions that reach a model never read dividends: those answers are
    // the page's own, so none are passed here rather than unchecked ones.
    const answer = await answerStillAgentHybridV2({ question, report, signedIn: true });
    res.status(200).json({ ok: true, answer });
  } catch (error) {
    logger.warn('Still agent hybrid ask failed', {
      errorName: error instanceof Error ? error.name : typeof error,
    });
    res.status(500).json({ ok: false, outcome: 'internal_error' });
  }
});
