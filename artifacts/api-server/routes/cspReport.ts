import express, { Router, type Request, type Response } from 'express';
import { logger } from '@mioagent/utils';

import { createCspReportRecorderV1, cspReportFactsV1, type CspReportFactV1 } from '../lib/cspReports.js';

/**
 * Where a browser reports a script the page's rule stopped, or would have (audit AUTH-7). No session:
 * the browser sends it by itself, with no cookie of ours to rely on. It answers 204 to everything, a
 * report or not, so it tells a sender nothing; the address limit that covers every route covers it too.
 */
export const cspReportRouter = Router();

export const cspReportRuntime = {
  write: (fact: CspReportFactV1): void => {
    logger.info('csp_report', { ...fact });
  },
};

const recorder = createCspReportRecorderV1({ write: (fact) => cspReportRuntime.write(fact) });

cspReportRouter.post(
  '/csp-report',
  // The app's own parser reads `application/json` only, and a browser sends neither of these as that.
  express.json({ type: ['application/csp-report', 'application/reports+json'], limit: '16kb', inflate: false }),
  (req: Request, res: Response) => {
    for (const fact of cspReportFactsV1(req.body)) recorder.record(fact);
    res.status(204).end();
  },
);
