import express, { Router, type Request, type Response } from 'express';
import { logger } from '@mioagent/utils';

import { createCspReportRecorderV1, cspReportFactsV1, type CspReportDroppedV1, type CspReportFactV1 } from '../lib/cspReports.js';
import { STILL_PUBLIC_ORIGIN_V1 } from '../lib/stillOrigin.js';
import { requestAddressKeyV1 } from '../middleware/rate-limit.js';

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
  // What an hour did not write, said once when the next one begins (audit AUTH-2): never a sender.
  writeDropped: (dropped: CspReportDroppedV1): void => {
    logger.warn('csp_report_dropped', { ...dropped });
  },
};

// Still's own origin: a report naming it is about Still's own page and files, and keeps the hour's last lines.
const recorder = createCspReportRecorderV1({ write: (fact) => cspReportRuntime.write(fact),
  writeDropped: (dropped) => cspReportRuntime.writeDropped(dropped), ownOrigins: [STILL_PUBLIC_ORIGIN_V1] });

cspReportRouter.post(
  '/csp-report',
  // The app's own parser reads `application/json` only, and a browser sends neither of these as that.
  express.json({ type: ['application/csp-report', 'application/reports+json'], limit: '16kb', inflate: false }),
  (req: Request, res: Response) => {
    // Counted by sender, an IPv4 address or an IPv6 /64, so one sender cannot fill the hour; the sender is never written.
    const sender = requestAddressKeyV1(req);
    for (const fact of cspReportFactsV1(req.body)) recorder.record(fact, sender);
    res.status(204).end();
  },
);
